import { readFile } from "node:fs/promises";
import { streamText, stepCountIs, type ToolSet } from "ai";
import type { AppConfig, TokenUsageSource } from "@shared/types";
import type { ModelFactory } from "./model-factory";
import { resolveOpenAIStoreOption } from "./provider-utils";
import { stripEmotionTags } from "./emotion-tags";
import type { YobiMemory } from "@main/memory/setup";
import type { ToolApprovalHandler, ToolRegistry } from "@main/tools/types";
import { reportTokenUsage } from "@main/services/token/token-usage-reporter";
import { assembleContext } from "@main/memory-v2/context-assembler";
import { extractQueryTerms, matchEpisodes } from "@main/memory-v2/retrieval";
import type { StateStore } from "@main/kernel/state-store";
import { CompanionPaths } from "@main/storage/paths";
import { AppLogger } from "@main/services/logger";
const logger = new AppLogger(new CompanionPaths());

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
  constructor(
    private readonly memory: YobiMemory,
    private readonly modelFactory: ModelFactory,
    private readonly toolRegistry: ToolRegistry,
    private readonly stateStore: StateStore,
    private readonly paths: CompanionPaths,
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

    const [soul, persona, profile, facts, episodes] = await Promise.all([
      readFile(this.paths.soulPath, "utf8").catch(() => ""),
      readFile(this.paths.personaPath, "utf8").catch(() => ""),
      this.memory.getProfile(),
      this.memory.listFacts(),
      this.memory.listRecentEpisodes(30)
    ]);
    const stateSnapshot = this.stateStore.getSnapshot();
    const buffer = await this.memory.listRecentBufferMessages(config.memory.recentMessages);
    const queryTexts = buffer
      .filter((item) => item.role === "user")
      .slice(-3)
      .map((item) => item.text);
    const [factCandidates, episodeCandidates] = await Promise.all([
      this.memory.searchRelevantFacts({
        queryTexts,
        facts,
        limit: 20
      }),
      Promise.resolve(matchEpisodes(episodes, extractQueryTerms(queryTexts), 8))
    ]);
    const assembled = assembleContext({
      soul: soul.trim(),
      persona: persona.trim(),
      stage: stateSnapshot.relationship.stage,
      state: stateSnapshot,
      profile,
      buffer,
      facts: factCandidates.map((row) => row.fact),
      episodes: episodeCandidates.map((row) => row.episode),
      maxTokens: Math.min(24_000, Math.max(4_000, config.openclaw.contextTokens || 8_000)),
      memoryFloorTokens: config.memory.context.memoryFloorTokens
    });

    if (assembled.selectedFacts.length > 0) {
      await this.memory.touchFacts(assembled.selectedFacts.map((fact) => fact.id));
    }

    const system = [assembled.system, input.photoUrl ? `\n用户这轮附带图片 URL: ${input.photoUrl}` : ""]
      .filter(Boolean)
      .join("\n\n");

    const messages = await this.memory.mapRecentToModelMessages(
      {
        threadId: input.threadId,
        resourceId: input.resourceId
      },
      assembled.maxRecentMessages
    );

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
        systemText: system,
        inputText: normalizedText,
        outputText: finalText
      });
    } catch (error) {
      logger.warn("conversation", "token-usage-capture-failed", undefined, error);
    }

    return finalText;
  }

  async rememberAssistantMessage(input: {
    text: string;
    channel: "telegram" | "console" | "qq";
    resourceId: string;
    threadId: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const rawText = input.text.trim();
    if (!rawText) {
      return;
    }
    const finalText = stripEmotionTags(rawText).trim() || rawText;
    await this.memory.rememberMessage({
      threadId: input.threadId,
      resourceId: input.resourceId,
      role: "assistant",
      text: finalText,
      metadata: {
        channel: input.channel,
        ...(input.metadata ?? {})
      }
    });
  }
}
