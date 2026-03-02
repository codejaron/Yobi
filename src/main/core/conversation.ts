import { generateText, streamText, stepCountIs, type ToolSet } from "ai";
import type { AppConfig } from "@shared/types";
import type { CharacterStore } from "./character";
import type { ModelFactory } from "./model-factory";
import { resolveOpenAIStoreOption } from "./provider-utils";
import type { YobiMemory } from "@main/memory/setup";
import type { ToolApprovalHandler, ToolRegistry } from "@main/tools/types";

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

export class ConversationEngine {
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

    const finalText = trimmedText || "我这次没有生成有效回复，请重试一次。";

    await this.memory.rememberMessage({
      threadId: input.threadId,
      resourceId: input.resourceId,
      role: "assistant",
      text: finalText,
      metadata: {
        channel: input.channel
      }
    });

    void this.refreshWorkingMemory({
      threadId: input.threadId,
      resourceId: input.resourceId,
      userText: normalizedText,
      assistantText: finalText,
      currentWorkingMemory: recalled.workingMemory,
      workingMemoryTemplate: character.workingMemoryTemplate ?? recalled.workingMemory
    });

    return finalText;
  }

  async rememberAssistantMessage(input: {
    text: string;
    channel: "telegram" | "console" | "qq";
    resourceId: string;
    threadId: string;
    metadata?: Record<string, unknown>;
    userTextForWorkingMemory?: string;
  }): Promise<void> {
    const normalizedText = input.text.trim();
    if (!normalizedText) {
      return;
    }

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

    void this.refreshWorkingMemory({
      threadId: input.threadId,
      resourceId: input.resourceId,
      userText: input.userTextForWorkingMemory?.trim() || "(无，本轮为助手主动消息)",
      assistantText: normalizedText,
      currentWorkingMemory: recalled.workingMemory,
      workingMemoryTemplate: character.workingMemoryTemplate ?? recalled.workingMemory
    });
  }

  private async refreshWorkingMemory(input: {
    threadId: string;
    resourceId: string;
    userText: string;
    assistantText: string;
    currentWorkingMemory: string;
    workingMemoryTemplate: string;
  }): Promise<void> {
    try {
      const model = this.modelFactory.getChatModel();
      const response = await generateText({
        model,
        providerOptions: resolveOpenAIStoreOption(this.getConfig()),
        system: [
          "你负责维护 Yobi 的工作记忆。这份记忆是 Yobi 对用户和自身状态的持续认知，每轮对话后更新。",
          "输出必须是 markdown，结构严格沿用模板的所有 section，不要省略任何 section，不要添加解释性文字。",
          "更新规则：",
          "- 「用户」「兴趣与偏好」：只在用户明确透露新信息时更新。不要从单次对话过度推断。",
          "- 「交流偏好」：通过多轮对话积累判断——用户的回复长度、语气、对哪种风格回应更积极。不要在前几次对话就下结论。",
          '- 「重要记忆」：只记录具体事件，带时间感。好的例子：“用户提到下周三有面试，有点紧张”。坏的例子：“用户是一个容易紧张的人”。最多保留 15 条，太旧且不再相关的移除。',
          "- 「待跟进」：新增用户提到但未完结的事项。如果某事已有后续（用户反馈了结果或不再相关），移除或移入重要记忆。",
          "- 「关系」：阶段变化应该很慢。不要因为一次愉快的聊天就从“初识”跳到“老朋友”。里程碑只记录真正有意义的节点。当前氛围基于最近 3-5 次交流的整体感觉判断。",
          "- 「Yobi 自身」：基于当前对话内容和历史更新 Yobi 的情绪。如果用户分享了好事 → 开心。如果用户好几天没说话刚回来 → 可以带点小委屈。如果对话很无聊 → 可以是有点无聊。「对用户的小观察」记录 Yobi 注意到但不适合直接说出口的东西。",
          "- 「当前对话」：每轮都更新。总结本次对话到目前的主线、走向、以及用户随口提到但没展开的点。如果本轮是新对话的开始，清空上次的内容重新开始。"
        ].join("\n"),
        prompt: [
          `工作记忆模板:\n${input.workingMemoryTemplate}`,
          `当前工作记忆:\n${input.currentWorkingMemory}`,
          `本轮用户消息:\n${input.userText}`,
          `本轮助手回复:\n${input.assistantText}`,
          "请返回更新后的完整工作记忆 markdown。"
        ].join("\n\n"),
        maxOutputTokens: 800
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
