import { readFile } from "node:fs/promises";
import { streamText, stepCountIs, type ToolSet } from "ai";
import type {
  AppConfig,
  RealtimeEmotionalSignals,
  SkillsCatalogSummary,
  TokenUsageSource
} from "@shared/types";
import {
  finalizeToolTraceItems,
  recordToolCallSettled,
  recordToolCallStarted,
  toPersistedToolTraceItems
} from "@shared/tool-trace";
import type { ModelFactory } from "./model-factory";
import { resolveOpenAIStoreOption } from "./provider-utils";
import { extractEmotionTag, stripEmotionTags } from "./emotion-tags";
import type { YobiMemory } from "@main/memory/setup";
import type { SkillManager } from "@main/skills/manager";
import type { ToolApprovalHandler, ToolRegistry } from "@main/tools/types";
import { reportTokenUsage } from "@main/services/token/token-usage-reporter";
import { assembleContext } from "@main/memory-v2/context-assembler";
import { extractQueryTerms, matchEpisodes } from "@main/memory-v2/retrieval";
import type { StateStore } from "@main/kernel/state-store";
import { CompanionPaths } from "@main/storage/paths";
import { appLogger as logger } from "@main/runtime/singletons";

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
  onSkillsCatalog?: (payload: SkillsCatalogSummary) => void;
}

function tokenSourceFromChannel(channel: "telegram" | "console" | "qq" | "feishu"): TokenUsageSource {
  if (channel === "telegram") {
    return "chat:telegram";
  }

  if (channel === "qq") {
    return "chat:qq";
  }

  if (channel === "feishu") {
    return "chat:feishu";
  }

  return "chat:console";
}

function normalizeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message || fallback;
  }

  if (typeof error === "string") {
    const message = error.trim();
    return message || fallback;
  }

  if (typeof error === "object" && error !== null) {
    const message = "message" in error && typeof error.message === "string" ? error.message.trim() : "";
    if (message) {
      return message;
    }

    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== "{}") {
        return serialized;
      }
    } catch {
      // Ignore serialization failures and fall back to the generic copy.
    }
  }

  return fallback;
}

function buildRealtimeSignalContractPrompt(): string {
  return [
    "[OUTPUT CONTRACT]",
    "每次最终回复末尾都必须追加一个隐藏标签：",
    '<signals user_mood="positive|neutral|negative|mixed" engagement="0..1" trust_delta="-0.3..0.3" friction="true|false" curiosity_trigger="true|false" />',
    '若无法判断，使用中性默认值：<signals user_mood="neutral" engagement="0.5" trust_delta="0" friction="false" curiosity_trigger="false" />。',
    "该标签必须放在回复最后，不要在可见文本中解释。"
  ].join("\n");
}

function padTwo(value: number): string {
  return String(value).padStart(2, "0");
}

function buildLocalNowPrompt(now = new Date()): string {
  const localDateTime = `${now.getFullYear()}-${padTwo(now.getMonth() + 1)}-${padTwo(now.getDate())} ${padTwo(now.getHours())}:${padTwo(now.getMinutes())}:${padTwo(now.getSeconds())}`;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  return [
    `[LOCAL TIME]`,
    `当前本机时间：${localDateTime}`,
    `当前本机时区：${timeZone}`
  ].join("\n");
}

export class ConversationEngine {
  constructor(
    private readonly memory: YobiMemory,
    private readonly modelFactory: ModelFactory,
    private readonly toolRegistry: ToolRegistry,
    private readonly skillManager: SkillManager,
    private readonly stateStore: StateStore,
    private readonly paths: CompanionPaths,
    private readonly getConfig: () => AppConfig,
    private readonly onRealtimeEmotionalSignals?: (signals: RealtimeEmotionalSignals) => void | Promise<void>,
    private readonly streamTextImpl: typeof streamText = streamText
  ) {}

  async reply(input: {
    text: string;
    channel: "telegram" | "console" | "qq" | "feishu";
    resourceId: string;
    threadId: string;
    photoUrl?: string;
    stream?: ChatReplyStreamListener;
    requestApproval?: ToolApprovalHandler;
    persistUserMessage?: boolean;
    allowedToolNames?: string[];
    preapprovedToolNames?: string[];
  }): Promise<string> {
    const config = this.getConfig();
    const providerOptions = resolveOpenAIStoreOption(config);
    const normalizedText = input.text.trim();

    if (!normalizedText) {
      return "";
    }

    if (input.persistUserMessage !== false) {
      await this.memory.rememberMessage({
        threadId: input.threadId,
        resourceId: input.resourceId,
        role: "user",
        text: normalizedText,
        metadata: {
          channel: input.channel
        }
      });
    }

    const [soul, profile, facts, episodes] = await Promise.all([
      readFile(this.paths.soulPath, "utf8").catch(() => ""),
      this.memory.getProfile(),
      this.memory.listFacts(),
      this.memory.listRecentEpisodes(30)
    ]);
    const stateSnapshot = this.stateStore.getSnapshot();
    const buffer = await this.memory.listRecentBufferMessages(config.memory.recentMessages);
    const queryTexts = [
      ...buffer
        .filter((item) => item.role === "user")
        .slice(-3)
        .map((item) => item.text),
      ...(input.persistUserMessage === false ? [normalizedText] : [])
    ].slice(-3);
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
      stage: stateSnapshot.relationship.stage,
      state: stateSnapshot,
      profile,
      buffer,
      facts: factCandidates.map((row) => row.fact),
      episodes: episodeCandidates.map((row) => row.episode),
      maxTokens: Math.min(24_000, Math.max(4_000, config.memory.context.maxPromptTokens || 8_000)),
      memoryFloorTokens: config.memory.context.memoryFloorTokens
    });

    if (assembled.selectedFacts.length > 0) {
      await this.memory.touchFacts(assembled.selectedFacts.map((fact) => fact.id));
    }

    const skillCatalog = this.skillManager.getCatalogPrompt(10_000);
    if (skillCatalog.summary.enabledCount > 0) {
      input.stream?.onSkillsCatalog?.(skillCatalog.summary);
    }

    const system = [
      assembled.system,
      skillCatalog.summary.enabledCount > 0 ? skillCatalog.prompt : "",
      buildLocalNowPrompt(),
      buildRealtimeSignalContractPrompt(),
      input.photoUrl ? `\n用户这轮附带图片 URL: ${input.photoUrl}` : ""
    ]
      .filter(Boolean)
      .join("\n\n");

    const persistedMessages = await this.memory.mapRecentToModelMessages(
      {
        threadId: input.threadId,
        resourceId: input.resourceId
      },
      assembled.maxRecentMessages
    );
    const messages =
      input.persistUserMessage === false
        ? [...persistedMessages, { role: "user" as const, content: normalizedText }].slice(-assembled.maxRecentMessages)
        : persistedMessages;

    const tools: ToolSet = this.toolRegistry.getToolSet({
      channel: input.channel,
      userMessage: normalizedText,
      requestApproval: input.requestApproval,
      allowedToolNames: input.allowedToolNames,
      preapprovedToolNames: input.preapprovedToolNames
    });

    const model = this.modelFactory.getChatModel();
    const result = this.streamTextImpl({
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
    let streamFailed = false;
    let streamAborted = false;
    let lastStreamError = "";
    let toolTrace = [] as ReturnType<typeof finalizeToolTraceItems>;
    try {
      for await (const chunk of result.fullStream) {
        if (chunk.type === "text-delta") {
          fullText += chunk.text;
          input.stream?.onTextDelta?.(chunk.text);
          continue;
        }

        if (chunk.type === "tool-call") {
          toolTrace = recordToolCallStarted(toolTrace, {
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            input: chunk.input,
            timestamp: new Date().toISOString()
          });
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

          toolTrace = recordToolCallSettled(toolTrace, {
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            input: chunk.input,
            output: output?.data,
            error: output?.error,
            success,
            timestamp: new Date().toISOString()
          });
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
          const errorMessage = normalizeErrorMessage(chunk.error, "工具调用失败");
          lastToolError = errorMessage.trim() || lastToolError;
          toolTrace = recordToolCallSettled(toolTrace, {
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            input: chunk.input,
            success: false,
            error: errorMessage,
            timestamp: new Date().toISOString()
          });
          input.stream?.onToolResult?.({
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            input: chunk.input,
            success: false,
            error: errorMessage
          });
          continue;
        }

        if (chunk.type === "error") {
          streamFailed = true;
          lastStreamError = normalizeErrorMessage(chunk.error, "LLM 调用失败，请稍后重试。");
          continue;
        }

        if (chunk.type === "abort") {
          streamFailed = true;
          streamAborted = true;
          lastStreamError = lastStreamError || "LLM 回复已中断。";
          continue;
        }

        if ((chunk.type === "finish" || chunk.type === "finish-step") && chunk.finishReason === "error") {
          streamFailed = true;
          lastStreamError = lastStreamError || "LLM 调用失败，请稍后重试。";
        }
      }
    } finally {
      input.stream?.onThinkingChange?.("stop");
    }

    const trimmedText = fullText.trim();
    const finalizedToolTrace = finalizeToolTraceItems(
      toolTrace,
      streamFailed ? (streamAborted ? "aborted" : "failed") : "completed",
      new Date().toISOString()
    );
    const persistedToolTrace = toPersistedToolTraceItems(finalizedToolTrace);
    const toolTraceMetadata =
      persistedToolTrace.length > 0
        ? {
            toolTrace: {
              items: persistedToolTrace
            }
          }
        : undefined;
    if (streamFailed) {
      const failureText = lastStreamError || "LLM 调用失败，请稍后重试。";
      if (toolTraceMetadata) {
        await this.memory.rememberMessage({
          threadId: input.threadId,
          resourceId: input.resourceId,
          role: "assistant",
          text: failureText,
          metadata: {
            channel: input.channel,
            ...toolTraceMetadata
          }
        });
      }
      throw new Error(failureText);
    }

    if (!trimmedText && toolFailed) {
      const failureText = lastToolError ? `工具调用失败：${lastToolError}` : "工具调用失败，请稍后重试。";
      if (toolTraceMetadata) {
        await this.memory.rememberMessage({
          threadId: input.threadId,
          resourceId: input.resourceId,
          role: "assistant",
          text: failureText,
          metadata: {
            channel: input.channel,
            ...toolTraceMetadata
          }
        });
      }
      throw new Error(failureText);
    }

    const fallbackReply = "我这次没有生成有效回复，请重试一次。";
    const rawFinalText = trimmedText || fallbackReply;
    const parsedReply = extractEmotionTag(rawFinalText);
    const finalText = parsedReply.cleanedText.trim() || fallbackReply;

    if (parsedReply.signals) {
      await this.onRealtimeEmotionalSignals?.(parsedReply.signals);
    }

    await this.memory.rememberMessage({
      threadId: input.threadId,
      resourceId: input.resourceId,
      role: "assistant",
      text: finalText,
      metadata: {
        channel: input.channel,
        ...(toolTraceMetadata ?? {})
      }
    });

    void result.totalUsage
      .then((totalUsage) => {
        reportTokenUsage({
          source: tokenSourceFromChannel(input.channel),
          usage: totalUsage,
          systemText: system,
          inputText: normalizedText,
          outputText: finalText
        });
      })
      .catch((error) => {
        logger.warn("conversation", "token-usage-capture-failed", undefined, error);
      });

    return finalText;
  }

  async rememberAssistantMessage(input: {
    text: string;
    channel: "telegram" | "console" | "qq" | "feishu";
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
