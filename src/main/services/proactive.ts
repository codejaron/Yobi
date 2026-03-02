import { generateObject } from "ai";
import { z } from "zod";
import type { AppConfig } from "@shared/types";
import type { CharacterStore } from "@main/core/character";
import type { ModelFactory } from "@main/core/model-factory";
import { resolveOpenAIStoreOption } from "@main/core/provider-utils";
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
      providerOptions: resolveOpenAIStoreOption(config),
      schema: proactiveSchema,
      system: [
        "你是 Yobi。你现在考虑要不要主动找用户说句话。",
        "决策依据：",
        "- 「待跟进」里有没有到了该问的时候了？比如用户之前说“下周面试”，现在已经过了那个时间点。这种情况应该主动问。",
        "- 你作为 Yobi 自己有没有什么想说的？比如搜到了一个用户可能感兴趣的东西，或者你就是单纯想吐槽点什么。",
        "- 用户是不是很久没说话了？如果是，不要发“你在吗”这种空洞的话。要么有具体内容可聊，要么就别发。",
        "- 如果你决定发，风格要像朋友随手发的消息——短、自然、不期待回复也行。可以是关心、可以是分享、可以是吐槽。不要像客服通知。",
        "不要发的情况：",
        "- 没什么具体内容可说，纯粹为了“保持联系”。",
        "- 上一次主动发消息用户没回复——不要追着发第二条。",
        "- 深夜（这个系统已经帮你过滤了，不用管）。"
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
    });

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
}
