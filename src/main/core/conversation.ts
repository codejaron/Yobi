import { generateText, streamText, stepCountIs, type ToolSet } from "ai";
import type { AppConfig, TokenUsageSource } from "@shared/types";
import type { CharacterStore } from "./character";
import type { ModelFactory } from "./model-factory";
import { resolveOpenAIStoreOption } from "./provider-utils";
import { stripEmotionTags } from "./emotion-tags";
import type { YobiMemory } from "@main/memory/setup";
import type { ToolApprovalHandler, ToolRegistry } from "@main/tools/types";
import { reportTokenUsage } from "@main/services/token/token-usage-reporter";

export interface ChatReplyStreamListener {
  onThinkingChange?: (state: "start" | "stop") => void;
  onTextDelta?: (delta: string) => void;
  onToolCall?: (payload: {
    toolCallId: string;
    toolName: string;
    input: unknown;
  }) => void;
  onToolResult?: (payload: {
    toolCallId: string;
    toolName: string;
    input: unknown;
    success: boolean;
    output?: unknown;
    error?: string;
  }) => void;
}

function tokenSourceFromChannel(channel: "telegram" | "console" | "qq"): TokenUsageSource {
  if (channel === "telegram") {
    return "chat:telegram";
  }

  if (channel === "qq") {
    return "chat:qq";
  }

  return "chat:console";
}

export class ConversationEngine {
  private turnsSinceRefresh = 0;

  constructor(
    private readonly memory: YobiMemory,
    private readonly modelFactory: ModelFactory,
    private readonly toolRegistry: ToolRegistry,
    private readonly characterStore: CharacterStore,
    private readonly getConfig: () => AppConfig
  ) {}

  async reply(input: {
    text: string;
    channel: "telegram" | "console" | "qq";
    resourceId: string;
    threadId: string;
    photoUrl?: string;
    stream?: ChatReplyStreamListener;
    requestApproval?: ToolApprovalHandler;
  }): Promise<string> {
    const config = this.getConfig();
    const providerOptions = resolveOpenAIStoreOption(config);
    const character = await this.characterStore.getCharacter(config.characterId);
    const normalizedText = input.text.trim();

    if (!normalizedText) {
      return "";
    }

    await this.memory.rememberMessage({
      threadId: input.threadId,
      resourceId: input.resourceId,
      role: "user",
      text: normalizedText,
      metadata: {
        channel: input.channel
      }
    });

    const recalled = await this.memory.recall({
      threadId: input.threadId,
      resourceId: input.resourceId
    });

    const system = [
      character.systemPrompt,
      `\n用户画像:\n${recalled.workingMemory}`,
      input.photoUrl ? `\n用户这轮附带图片 URL: ${input.photoUrl}` : ""
    ]
      .filter(Boolean)
      .join("\n");

    const messages = await this.memory.mapRecentToModelMessages({
      threadId: input.threadId,
      resourceId: input.resourceId
    });

    const tools: ToolSet = this.toolRegistry.getToolSet({
      channel: input.channel,
      userMessage: normalizedText,
      requestApproval: input.requestApproval
    });

    const model = this.modelFactory.getChatModel();
    const result = streamText({
      model,
      system,
      messages,
      tools,
      toolChoice: "auto",
      providerOptions,
      stopWhen: stepCountIs(20)
    });

    input.stream?.onThinkingChange?.("start");

    let fullText = "";
    let toolFailed = false;
    let lastToolError = "";
    try {
      for await (const chunk of result.fullStream) {
        if (chunk.type === "text-delta") {
          fullText += chunk.text;
          input.stream?.onTextDelta?.(chunk.text);
          continue;
        }

        if (chunk.type === "tool-call") {
          input.stream?.onToolCall?.({
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            input: chunk.input
          });
          continue;
        }

        if (chunk.type === "tool-result") {
          const output = chunk.output as {
            success?: boolean;
            data?: unknown;
            error?: string;
          };
          const success = output?.success ?? true;
          if (!success) {
            toolFailed = true;
            lastToolError = output?.error?.trim() || lastToolError;
          }

          input.stream?.onToolResult?.({
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            input: chunk.input,
            success,
            output: output?.data,
            error: output?.error
          });
          continue;
        }

        if (chunk.type === "tool-error") {
          toolFailed = true;
          const errorMessage =
            chunk.error instanceof Error
              ? chunk.error.message
              : typeof chunk.error === "string"
                ? chunk.error
                : "工具调用失败";
          lastToolError = errorMessage.trim() || lastToolError;
          input.stream?.onToolResult?.({
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            input: chunk.input,
            success: false,
            error: errorMessage
          });
        }
      }
    } finally {
      input.stream?.onThinkingChange?.("stop");
    }

    const trimmedText = fullText.trim();
    if (!trimmedText && toolFailed) {
      throw new Error(lastToolError ? `工具调用失败：${lastToolError}` : "工具调用失败，请稍后重试。");
    }

    const fallbackReply = "我这次没有生成有效回复，请重试一次。";
    const rawFinalText = trimmedText || fallbackReply;
    const finalText = stripEmotionTags(rawFinalText).trim() || fallbackReply;

    await this.memory.rememberMessage({
      threadId: input.threadId,
      resourceId: input.resourceId,
      role: "assistant",
      text: finalText,
      metadata: {
        channel: input.channel
      }
    });

    try {
      const totalUsage = await result.totalUsage;
      reportTokenUsage({
        source: tokenSourceFromChannel(input.channel),
        usage: totalUsage,
        inputText: normalizedText,
        outputText: finalText
      });
    } catch (error) {
      console.warn("[conversation] token usage capture failed:", error);
    }

    this.scheduleWorkingMemoryRefresh({
      threadId: input.threadId,
      resourceId: input.resourceId,
      currentWorkingMemory: recalled.workingMemory,
      workingMemoryTemplate: character.workingMemoryTemplate ?? recalled.workingMemory
    });

    return rawFinalText;
  }

  async rememberAssistantMessage(input: {
    text: string;
    channel: "telegram" | "console" | "qq";
    resourceId: string;
    threadId: string;
    metadata?: Record<string, unknown>;
    userTextForWorkingMemory?: string;
  }): Promise<void> {
    const rawText = input.text.trim();
    if (!rawText) {
      return;
    }
    const normalizedText = stripEmotionTags(rawText).trim() || rawText;

    await this.memory.rememberMessage({
      threadId: input.threadId,
      resourceId: input.resourceId,
      role: "assistant",
      text: normalizedText,
      metadata: {
        channel: input.channel,
        ...(input.metadata ?? {})
      }
    });

    const recalled = await this.memory.recall({
      threadId: input.threadId,
      resourceId: input.resourceId
    });
    const character = await this.characterStore.getCharacter(this.getConfig().characterId);

    this.scheduleWorkingMemoryRefresh({
      threadId: input.threadId,
      resourceId: input.resourceId,
      currentWorkingMemory: recalled.workingMemory,
      workingMemoryTemplate: character.workingMemoryTemplate ?? recalled.workingMemory
    });
  }

  private scheduleWorkingMemoryRefresh(input: {
    threadId: string;
    resourceId: string;
    currentWorkingMemory: string;
    workingMemoryTemplate: string;
  }): void {
    this.turnsSinceRefresh += 1;

    const isBlankMemory = input.currentWorkingMemory === input.workingMemoryTemplate;
    if (!isBlankMemory && this.turnsSinceRefresh < 50) {
      return;
    }

    this.turnsSinceRefresh = 0;
    void this.refreshWorkingMemory(input);
  }

  private async refreshWorkingMemory(input: {
    threadId: string;
    resourceId: string;
    currentWorkingMemory: string;
    workingMemoryTemplate: string;
  }): Promise<void> {
    try {
      const historyPage = await this.memory.listHistoryByCursor({
        threadId: input.threadId,
        resourceId: input.resourceId,
        limit: 50
      });
      const history = historyPage.items;

      if (history.length === 0) {
        return;
      }

      const exchanges = history
        .map((message) => `${message.role === "user" ? "用户" : "Yobi"}: ${message.text}`)
        .join("\n");

      const model = this.modelFactory.getChatModel();
      const systemPrompt = [
        "你负责维护 Yobi 的工作记忆。这份记忆同时记录用户画像和 Yobi 自身的状态。",
        "",
        "更新原则：",
        "- 有新信息才更新对应字段，没有则保持原内容不变。",
        "- 「交流风格」要从用户的实际行为推断（消息长度、用词习惯、对吐槽的反应），不要问用户。",
        "- 「关系阶段」根据互动深度和时间自然演进，不要跳级。新用户默认'新认识'。",
        "- 「Yobi 自身」要基于对话内容更新 Yobi 的心情、看法和关注点。Yobi 不总是开心的——如果用户冷淡，Yobi 可以记录'有点无聊'；如果聊得投机，可以记录'挺开心'。",
        "- 「重要记忆」只记录真正重要的事（承诺、里程碑、用户分享的重要经历），不要把每轮闲聊都塞进去。",
        "- 如果用户纠正了之前的信息，直接更新，不保留旧的错误版本。",
        "",
        "输出完整的 markdown，结构必须沿用模板，不添加解释。"
      ].join("\n");
      const userPrompt = [
        `模板结构:\n${input.workingMemoryTemplate}`,
        `当前工作记忆:\n${input.currentWorkingMemory}`,
        `最近 ${history.length} 轮对话:\n${exchanges}`,
        "请返回更新后的完整工作记忆。"
      ].join("\n\n");
      const response = await generateText({
        model,
        providerOptions: resolveOpenAIStoreOption(this.getConfig()),
        system: systemPrompt,
        prompt: userPrompt
      });

      reportTokenUsage({
        source: "background:working-memory",
        usage: response.totalUsage,
        systemText: systemPrompt,
        inputText: userPrompt,
        outputText: response.text
      });

      const markdown = response.text.trim();
      if (!markdown) {
        return;
      }

      await this.memory.updateWorkingMemoryFromSummary({
        threadId: input.threadId,
        resourceId: input.resourceId,
        markdown
      });
    } catch (error) {
      console.warn("[conversation] working memory refresh skipped:", error);
    }
  }
}
