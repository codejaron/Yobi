import { generateObject } from "ai";
import { z } from "zod";
import type {
  AppConfig,
  BrowseStatus,
  BrowseTopicMaterial
} from "@shared/types";
import type { CharacterStore } from "@main/core/character";
import type { ModelFactory } from "@main/core/model-factory";
import { resolveOpenAIStoreOption } from "@main/core/provider-utils";
import type { YobiMemory } from "@main/memory/setup";
import { reportTokenUsage } from "@main/services/token/token-usage-reporter";
import { isWithinQuietHours } from "./proactive-time-window";
import { buildCandidatePool, type ProactiveCandidateTopic } from "./proactive-candidates";

export type ProactiveTrigger = {
  type: "heartbeat";
  detail: string;
  silenceMs: number;
};

export type ProactiveDecisionKind = "eventShare" | "digestShare" | "reversePrompt" | "silent";

export interface ProactiveDecision {
  kind: ProactiveDecisionKind;
  speak: boolean;
  reason: string;
  message?: string;
  usedTopicId?: string;
}

type ProactiveTopicCandidate = ProactiveCandidateTopic & {
  material?: BrowseTopicMaterial;
};

const proactiveSchema = z.object({
  shouldSpeak: z.boolean(),
  usedTopicId: z.string().min(1).max(80).optional(),
  message: z.string().min(1).max(280).optional(),
  reason: z.string().min(1).max(160).default("model")
});

function parseTimestamp(value: string | null): number {
  if (!value) {
    return 0;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function nowMs(): number {
  return Date.now();
}

function compactText(value: string, max = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, max - 1)).trim()}...`;
}

function normalizeMessage(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toDecisionKindFromSource(source: string): ProactiveDecisionKind {
  if (source === "browse:event") {
    return "eventShare";
  }
  if (source === "browse:reverse") {
    return "reversePrompt";
  }
  return "digestShare";
}

function summarizeMaterial(material: BrowseTopicMaterial): Record<string, unknown> {
  return {
    title: compactText(material.title, 120),
    up: compactText(material.up, 40),
    tags: material.tags.slice(0, 6),
    plays: material.plays,
    duration: material.duration,
    publishedAt: material.publishedAt,
    desc: material.desc ? compactText(material.desc, 200) : undefined,
    topComments: material.topComments.slice(0, 5).map((comment) => ({
      text: compactText(comment.text, 80),
      likes: comment.likes
    })),
    url: material.url
  };
}

function summarizeTopics(topics: ProactiveTopicCandidate[]): Array<Record<string, unknown>> {
  return topics.map((topic) => ({
    id: topic.id,
    source: topic.source,
    text: compactText(topic.text, 120),
    material: topic.material ? summarizeMaterial(topic.material) : undefined
  }));
}

function mapConversationToPrompt(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
): string {
  const dialogue = messages
    .filter((message) => message.role === "assistant" || message.role === "user")
    .slice(-16)
    .map((message) => `${message.role === "user" ? "用户" : "你"}: ${compactText(message.content, 280)}`);

  if (dialogue.length === 0) {
    return "(暂无历史对话)";
  }

  return dialogue.join("\n");
}

export class ProactiveService {
  constructor(
    private readonly memory: YobiMemory,
    private readonly modelFactory: ModelFactory,
    private readonly characterStore: CharacterStore,
    private readonly getConfig: () => AppConfig
  ) {}

  async evaluate(input: {
    trigger: ProactiveTrigger;
    resourceId: string;
    threadId: string;
    lastProactiveAt: string | null;
    lastUserAt: string | null;
    browseStatus: BrowseStatus;
  }): Promise<ProactiveDecision> {
    const config = this.getConfig();
    if (!config.proactive.enabled) {
      return {
        kind: "silent",
        speak: false,
        reason: "disabled"
      };
    }

    if (isWithinQuietHours(new Date(), config.proactive.quietHours)) {
      return {
        kind: "silent",
        speak: false,
        reason: "quiet-hours"
      };
    }

    const lastUserMs = parseTimestamp(input.lastUserAt);
    const lastProactiveMs = parseTimestamp(input.lastProactiveAt);
    const lastInteractionMs = Math.max(lastUserMs, lastProactiveMs);
    const elapsedSinceInteraction =
      lastInteractionMs > 0 ? nowMs() - lastInteractionMs : Number.MAX_SAFE_INTEGER;

    const allowEventShare =
      input.browseStatus.todayEventShares < config.browse.eventDailyCap &&
      elapsedSinceInteraction >= config.browse.eventMinGapMs;

    const activeTopicsRaw = await this.memory.listActive(20);
    const activeTopics: ProactiveTopicCandidate[] = activeTopicsRaw
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const pool = buildCandidatePool({
      topics: activeTopics,
      allowEventShare,
      eventFreshWindowMs: config.browse.eventFreshWindowMs
    });

    if (input.trigger.silenceMs < config.proactive.silenceThresholdMs && pool.eventCandidates.length === 0) {
      return {
        kind: "silent",
        speak: false,
        reason: "silence-not-reached"
      };
    }

    if (pool.eventCandidates.length === 0 && lastProactiveMs > 0) {
      const elapsedSinceProactive = nowMs() - lastProactiveMs;
      if (elapsedSinceProactive < config.proactive.cooldownMs) {
        return {
          kind: "silent",
          speak: false,
          reason: "cooldown"
        };
      }
    }

    const candidates = pool.candidates.slice(0, 10);
    if (candidates.length === 0) {
      return {
        kind: "silent",
        speak: false,
        reason: allowEventShare ? "no-topic" : "event-blocked"
      };
    }

    const conversation = await this.memory.mapRecentToModelMessages({
      resourceId: input.resourceId,
      threadId: input.threadId
    });

    const history = await this.memory.listHistory({
      resourceId: input.resourceId,
      threadId: input.threadId,
      limit: 200,
      offset: 0
    });
    const proactiveCount = history.filter(
      (message) => message.role === "assistant" && message.meta?.proactive
    ).length;
    const reverseHintEvery = Math.max(2, config.browse.reversePromptEvery);
    const shouldPreferQuestion = proactiveCount > 0 && proactiveCount % reverseHintEvery === 0;

    const character = await this.characterStore.getCharacter(config.characterId);
    const model = this.modelFactory.getChatModel();
    const systemPrompt = [
      character.systemPrompt,
      "你正在执行主动聊天决策。目标是从候选话题里选最自然的一条，并直接说人话。",
      "必须避免播报腔、条目腔、客服腔，不要写成推荐卡片。",
      "message 只写 1-2 句，像熟人顺手分享。",
      "如果话题包含视频链接，要自然带上链接，不要生硬贴 URL。",
      "若当前时机不适合主动开口，返回 shouldSpeak=false。",
      "只能使用候选池里存在的 id 作为 usedTopicId，不得编造。"
    ].join("\n");
    const userPrompt = [
      `触发信息:\n${JSON.stringify(
        {
          trigger: input.trigger.detail,
          silenceMs: input.trigger.silenceMs,
          allowEventShare,
          shouldPreferQuestion
        },
        null,
        2
      )}`,
      `最近 8 轮对话:\n${mapConversationToPrompt(conversation)}`,
      `候选话题池 (最多 10 条):\n${JSON.stringify(summarizeTopics(candidates), null, 2)}`,
      "请返回 shouldSpeak/usedTopicId/message/reason。"
    ].join("\n\n");

    try {
      const result = await generateObject({
        model,
        providerOptions: resolveOpenAIStoreOption(config),
        schema: proactiveSchema,
        system: systemPrompt,
        prompt: userPrompt,
        maxOutputTokens: 320
      });

      reportTokenUsage({
        source: "background:proactive",
        usage: result.usage,
        systemText: systemPrompt,
        inputText: userPrompt,
        outputText: JSON.stringify(result.object ?? {})
      });

      const parsed = proactiveSchema.parse(result.object ?? {
        shouldSpeak: false,
        reason: "empty"
      });

      if (!parsed.shouldSpeak) {
        return {
          kind: "silent",
          speak: false,
          reason: parsed.reason || "model-silent"
        };
      }

      const usedTopicId = parsed.usedTopicId?.trim();
      const message = parsed.message ? normalizeMessage(parsed.message) : "";
      if (!usedTopicId || !message) {
        return {
          kind: "silent",
          speak: false,
          reason: "invalid-llm-output"
        };
      }

      const picked = candidates.find((topic) => topic.id === usedTopicId);
      if (!picked) {
        return {
          kind: "silent",
          speak: false,
          reason: "invalid-topic-id"
        };
      }

      return {
        kind: toDecisionKindFromSource(picked.source),
        speak: true,
        reason: parsed.reason || "model-picked",
        message,
        usedTopicId: picked.id
      };
    } catch {
      return {
        kind: "silent",
        speak: false,
        reason: "llm-error"
      };
    }
  }
}
