import { generateObject } from "ai";
import { z } from "zod";
import type { AppConfig } from "@shared/types";
import type { CharacterStore } from "@main/core/character";
import type { ModelFactory } from "@main/core/model-factory";
import type { YobiMemory } from "@main/memory/setup";

export type ProactiveTrigger = {
  type: "silence";
  detail: string;
};

const proactiveSchema = z.object({
  shouldSpeak: z.boolean(),
  reason: z.string().min(1),
  message: z.string().optional(),
  usedTopicIndex: z.number().int().min(1).max(3).optional()
});

export class ProactiveService {
  constructor(
    private readonly modelFactory: ModelFactory,
    private readonly memory: YobiMemory,
    private readonly characterStore: CharacterStore,
    private readonly getConfig: () => AppConfig
  ) {}

  async evaluate(input: {
    trigger: ProactiveTrigger;
    resourceId: string;
    threadId: string;
    lastProactiveAt: string | null;
  }): Promise<{ speak: boolean; message?: string; reason: string }> {
    const config = this.getConfig();
    if (!config.proactive.enabled) {
      return {
        speak: false,
        reason: "disabled"
      };
    }

    if (input.lastProactiveAt) {
      const elapsed = Date.now() - new Date(input.lastProactiveAt).getTime();
      if (elapsed < config.proactive.cooldownMs) {
        return {
          speak: false,
          reason: "cooldown"
        };
      }
    }

    const hour = new Date().getHours();
    if (hour >= 1 && hour < 7) {
      return {
        speak: false,
        reason: "nighttime"
      };
    }

    const model = this.modelFactory.getChatModel();
    const character = await this.characterStore.getCharacter(config.characterId);
    const history = await this.memory.listHistory({
      resourceId: input.resourceId,
      threadId: input.threadId,
      limit: 30,
      offset: 0
    });
    const pendingTopics = await this.memory.listActive(3);
    const topicHints =
      pendingTopics.length > 0
        ? pendingTopics.map((topic, index) => `${index + 1}. [${topic.source}] ${topic.text}`).join("\n")
        : "（暂无积攒的话题）";
    const workingMemory = await this.memory.getWorkingMemory({
      resourceId: input.resourceId,
      threadId: input.threadId
    });

    const decision = await generateObject({
      model,
      providerOptions: this.buildProviderOptions(config),
      schema: proactiveSchema,
      system: [
        "你是 Yobi。现在你有机会主动给用户发一条消息。",
        "大多数时候不发才是对的。不要为了说话而说话。",
        "如果要发，内容要自然、简短、有温度。"
      ].join("\n"),
      prompt: [
        character.systemPrompt,
        `触发原因: ${input.trigger.type}: ${input.trigger.detail}`,
        `当前时间: ${new Date().toLocaleString("zh-CN")}`,
        `工作记忆:\n${workingMemory.markdown}`,
        `最近对话:\n${history.map((item) => `[${item.timestamp}] ${item.role}: ${item.text}`).join("\n") || "(空)"}`,
        `候选话题池:\n${topicHints}`,
        "如果你用了候选话题，请返回 usedTopicIndex（1-based）。",
        "返回 shouldSpeak/reason/message/usedTopicIndex。"
      ].join("\n\n")
    } as any);

    const parsed = proactiveSchema.parse(decision.object ?? {
      shouldSpeak: false,
      reason: "empty"
    });

    if (!parsed.shouldSpeak || !parsed.message?.trim()) {
      return {
        speak: false,
        reason: parsed.reason
      };
    }

    const usedTopic = parsed.usedTopicIndex ? pendingTopics[parsed.usedTopicIndex - 1] : undefined;
    if (usedTopic) {
      await this.memory.markUsed(usedTopic.id);
    }

    return {
      speak: true,
      reason: parsed.reason,
      message: parsed.message.trim()
    };
  }

  private buildProviderOptions(config: AppConfig): Record<string, unknown> | undefined {
    const route = config.modelRouting.chat;
    const provider = config.providers.find((candidate) => candidate.id === route.providerId);
    if (!provider) {
      return undefined;
    }

    const usesResponsesApi =
      (provider.kind === "openai" || provider.kind === "custom-openai") &&
      provider.apiMode === "responses";

    if (!usesResponsesApi) {
      return undefined;
    }

    return {
      openai: {
        store: false
      }
    };
  }
}
