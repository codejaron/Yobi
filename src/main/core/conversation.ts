import { generateText, streamText, stepCountIs, type ToolSet } from "ai";
import type { AppConfig } from "@shared/types";
import type { CharacterStore } from "./character";
import type { ModelFactory } from "./model-factory";
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
    channel: "telegram" | "console";
    resourceId: string;
    threadId: string;
    photoUrl?: string;
    stream?: ChatReplyStreamListener;
    requestApproval?: ToolApprovalHandler;
  }): Promise<string> {
    const config = this.getConfig();
    const providerOptions = this.buildProviderOptions(config);
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
    } as any);

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
    channel: "telegram" | "console";
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
        providerOptions: this.buildProviderOptions(this.getConfig()),
        system: [
          "你负责维护用户工作记忆。",
          "输出必须是 markdown，结构必须沿用模板，不要添加解释。",
          "如果没有新信息，保持原内容。"
        ].join("\n"),
        prompt: [
          `工作记忆模板:\n${input.workingMemoryTemplate}`,
          `当前工作记忆:\n${input.currentWorkingMemory}`,
          `本轮用户消息:\n${input.userText}`,
          `本轮助手回复:\n${input.assistantText}`,
          "请返回更新后的完整工作记忆 markdown。"
        ].join("\n\n"),
        maxOutputTokens: 800
      } as any);

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
