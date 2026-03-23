import { readFile } from "node:fs/promises";
import { streamText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import type {
  AppConfig,
  AssistantTimelineBlock,
  ChatAttachment,
  RealtimeEmotionalSignals,
  SkillsCatalogSummary,
  TokenUsageSource,
  VoiceInputContext
} from "@shared/types";
import {
  applyConsoleEventToAssistantProcess,
  createAssistantTurnProcess,
  finalizeToolTraceItems,
  recordToolCallSettled,
  recordToolCallStarted,
  toPersistedAssistantTimelineBlocks,
  toPersistedToolTraceItems
} from "@shared/tool-trace";
import type { ModelFactory } from "./model-factory";
import {
  ConversationAbortError,
  isAbortLikeError,
  isConversationAbortError
} from "./conversation-abort";
import { resolveOpenAIStoreOption } from "./provider-utils";
import { createEmotionTagStripper, extractEmotionTag, extractRawSignalsTag, stripEmotionTags } from "./emotion-tags";
import type { YobiMemory } from "@main/memory/setup";
import { buildUserContentWithAttachments } from "@main/services/chat-media";
import type { SkillManager } from "@main/skills/manager";
import type { ToolApprovalHandler, ToolRegistry } from "@main/tools/types";
import { reportTokenUsage } from "@main/services/token/token-usage-reporter";
import { assembleContext } from "@main/memory-v2/context-assembler";
import { extractQueryTerms, matchEpisodes } from "@main/memory-v2/retrieval";
import { estimateTokenCount } from "@main/memory-v2/token-utils";
import { loadRelationshipGuide } from "@main/relationship/guide-store";
import type { StateStore } from "@main/kernel/state-store";
import { CompanionPaths } from "@main/storage/paths";
import { appLogger as logger } from "@main/runtime/singletons";

export interface ChatReplyStreamListener {
  onThinkingChange?: (state: "start" | "stop") => void;
  onTextDelta?: (delta: string) => void;
  onVisibleTextDelta?: (delta: string) => void;
  onVisibleTextFinal?: (text: string) => void;
  onAbortVisibleText?: (text: string) => void;
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

function createAssistantTimelineMetadata(blocks: AssistantTimelineBlock[] | undefined) {
  return blocks && blocks.length > 0
    ? {
        assistantTimeline: {
          blocks
        }
      }
    : undefined;
}

function ensureTimelineHasTrailingText(
  blocks: AssistantTimelineBlock[],
  text: string
): AssistantTimelineBlock[] {
  if (!text.trim()) {
    return blocks;
  }

  const hasTextBlock = blocks.some((block) => block.type === "text");
  if (hasTextBlock) {
    return blocks;
  }

  return [...blocks, { type: "text", text }];
}

function getToolOnlyTimelineBlocks(blocks: AssistantTimelineBlock[]): AssistantTimelineBlock[] {
  return blocks.filter((block) => block.type === "tool");
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
    '<signals emotion_label="OpenFeelz upstream label" intensity="0..1" trust_delta="-0.3..0.3" engagement="0..1" />',
    "emotion_label 表示 Yobi 被这轮用户输入唤起的内部情绪，不是直接复述用户原话里的情绪词。",
    'emotion_label 必须使用 OpenFeelz 上游标签，例如 calm、happy、anxious、frustrated、curious、connected、fatigued、neutral。',
    '若无法判断，使用中性默认值：<signals emotion_label="neutral" intensity="0.5" trust_delta="0" engagement="0.5" />。',
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

function buildVoiceInputContextPrompt(voiceContext: VoiceInputContext): string {
  const details = [
    `provider: ${voiceContext.provider}`,
    `language: ${voiceContext.metadata.language ?? "unknown"}`,
    `emotion: ${voiceContext.metadata.emotion ?? "unknown"}`,
    `event: ${voiceContext.metadata.event ?? "unknown"}`
  ].join("\n");

  const rawTags =
    voiceContext.metadata.rawTags.length > 0
      ? `raw_tags: ${voiceContext.metadata.rawTags.join(", ")}`
      : "raw_tags: none";

  return [
    "[VOICE INPUT CONTEXT]",
    "The current user turn comes from speech recognition. Use these signals to interpret tone and intent, but do not quote or expose this metadata unless explicitly asked.",
    details,
    rawTags
  ].join("\n");
}

function buildTaskModePrompt(): string {
  return [
    "[TASK MODE]",
    "当前控制台会话处于任务模式。面对明确任务请求时，优先执行、搜索、读取、分解并持续推进，不要把先问用户当作默认动作。",
    "对缺失但可合理假设的细节，先采用保守默认值继续推进，并在结果里简短说明假设。",
    "仅在以下情况追问：缺少关键输入会导致结果无意义；存在多个高影响方向且默认值风险明显；执行需要用户授权、外部资源或人工判断；继续执行会产生明显副作用或错误结论。",
    "若工具失败，优先尝试同轮内替代路径，而不是立即回头问用户。",
    "输出风格偏执行型，减少寒暄和反问，但不要突破已有安全边界。"
  ].join("\n");
}

export class ConversationEngine {
  private cognitionMemoryProvider: ((input: { userText: string }) => Promise<string>) | null = null;

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

  setCognitionMemoryProvider(provider: ((input: { userText: string }) => Promise<string>) | null): void {
    this.cognitionMemoryProvider = provider;
  }

  async reply(input: {
    text: string;
    attachments?: ChatAttachment[];
    channel: "telegram" | "console" | "qq" | "feishu";
    resourceId: string;
    threadId: string;
    photoUrl?: string;
    stream?: ChatReplyStreamListener;
    requestApproval?: ToolApprovalHandler;
    persistUserMessage?: boolean;
    assistantPersistence?: "engine" | "caller";
    allowedToolNames?: string[];
    preapprovedToolNames?: string[];
    taskMode?: boolean;
    voiceContext?: VoiceInputContext;
    abortSignal?: AbortSignal;
  }): Promise<string> {
    const config = this.getConfig();
    const providerOptions = resolveOpenAIStoreOption(config);
    const normalizedText = input.text.trim();
    const attachments = input.attachments ?? [];

    if (!normalizedText && attachments.length === 0) {
      return "";
    }

    if (input.persistUserMessage !== false) {
      await this.memory.rememberMessage({
        threadId: input.threadId,
        resourceId: input.resourceId,
        role: "user",
        text: normalizedText,
        metadata: {
          channel: input.channel,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(input.voiceContext
            ? {
                speechRecognition: {
                  provider: input.voiceContext.provider,
                  ...input.voiceContext.metadata
                }
              }
            : {})
        }
      });
    }

    const [soul, relationship, profile, facts, episodes] = await Promise.all([
      readFile(this.paths.soulPath, "utf8").catch(() => ""),
      loadRelationshipGuide(this.paths),
      this.memory.getProfile(),
      this.memory.listFacts(),
      this.memory.listRecentEpisodes(30)
    ]);
    const skillCatalog = this.skillManager.getCatalogPrompt(10_000);
    if (skillCatalog.summary.enabledCount > 0) {
      input.stream?.onSkillsCatalog?.(skillCatalog.summary);
    }
    const stateSnapshot = this.stateStore.getSnapshot();
    const buffer = await this.memory.listRecentBufferMessages(config.memory.recentMessages);
    const queryTexts = [
      ...buffer
        .filter((item) => item.role === "user")
        .slice(-3)
        .map((item) => item.text),
      ...(input.persistUserMessage === false && normalizedText ? [normalizedText] : [])
    ]
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(-3);
    const [factCandidates, episodeCandidates, cognitionMemoryBlock] = await Promise.all([
      this.memory.searchRelevantFacts({
        queryTexts,
        facts,
        limit: 20
      }),
      Promise.resolve(matchEpisodes(episodes, extractQueryTerms(queryTexts), 8)),
      this.cognitionMemoryProvider
        ? this.cognitionMemoryProvider({
            userText: normalizedText
          }).catch(() => "")
        : Promise.resolve("")
    ]);
    const externalPromptBlocks = [
      skillCatalog.summary.enabledCount > 0 ? skillCatalog.prompt : "",
      buildLocalNowPrompt(),
      input.channel === "console" && input.taskMode ? buildTaskModePrompt() : "",
      buildRealtimeSignalContractPrompt(),
      cognitionMemoryBlock,
      input.voiceContext ? buildVoiceInputContextPrompt(input.voiceContext) : "",
      input.photoUrl ? `用户这轮附带图片 URL: ${input.photoUrl}` : ""
    ].filter(Boolean);
    const assembled = assembleContext({
      soul: soul.trim(),
      relationship,
      stage: stateSnapshot.relationship.stage,
      state: stateSnapshot,
      profile,
      buffer,
      facts: factCandidates.map((row) => row.fact),
      episodes: episodeCandidates.map((row) => row.episode),
      maxTokens: Math.min(24_000, Math.max(4_000, config.memory.context.maxPromptTokens || 8_000)),
      memoryFloorTokens: config.memory.context.memoryFloorTokens,
      externalFixedTokens: estimateTokenCount(externalPromptBlocks.join("\n\n"))
    });

    if (assembled.selectedFacts.length > 0) {
      await this.memory.touchFacts(assembled.selectedFacts.map((fact) => fact.id));
    }

    const system = [
      assembled.system,
      ...externalPromptBlocks
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
    const messages: ModelMessage[] = [...persistedMessages];
    if (input.persistUserMessage === false) {
      const currentUserContent = await buildUserContentWithAttachments({
        text: normalizedText,
        attachments,
        includeMedia: true
      });
      messages.push({
        role: "user",
        content: currentUserContent.content
      });
    }
    const boundedMessages = messages.slice(-assembled.maxRecentMessages);

    const tools: ToolSet = this.toolRegistry.getToolSet({
      channel: input.channel,
      userMessage: normalizedText,
      requestApproval: input.requestApproval,
      allowedToolNames: input.allowedToolNames,
      preapprovedToolNames: input.preapprovedToolNames
    });

    const model = this.modelFactory.getChatModel();

    let fullText = "";
    let toolFailed = false;
    let lastToolError = "";
    let streamFailed = false;
    let streamAborted = false;
    let lastStreamError = "";
    let toolTrace = [] as ReturnType<typeof finalizeToolTraceItems>;
    let assistantProcess = createAssistantTurnProcess();
    const processRequestId = "conversation-persist";
    const visibleStripper = createEmotionTagStripper();
    const result = this.streamTextImpl({
      model,
      system,
      messages: boundedMessages,
      tools,
      toolChoice: "auto",
      providerOptions,
      stopWhen: stepCountIs(20),
      abortSignal: input.abortSignal,
      onAbort: () => {
        streamAborted = true;
        lastStreamError = lastStreamError || "LLM 回复已中断。";
      }
    });

    input.stream?.onThinkingChange?.("start");
    try {
      try {
        for await (const chunk of result.fullStream) {
          if (input.abortSignal?.aborted) {
            streamFailed = true;
            streamAborted = true;
            lastStreamError = lastStreamError || "LLM 回复已中断。";
            break;
          }

          if (chunk.type === "text-delta") {
            fullText += chunk.text;
            input.stream?.onTextDelta?.(chunk.text);
            const visibleDelta = visibleStripper.push(chunk.text);
            if (visibleDelta) {
              assistantProcess = applyConsoleEventToAssistantProcess(assistantProcess, {
                requestId: processRequestId,
                type: "text-delta",
                delta: visibleDelta,
                timestamp: new Date().toISOString()
              });
              input.stream?.onVisibleTextDelta?.(visibleDelta);
            }
            continue;
          }

          if (chunk.type === "tool-call") {
            const timestamp = new Date().toISOString();
            toolTrace = recordToolCallStarted(toolTrace, {
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              input: chunk.input,
              timestamp
            });
            assistantProcess = applyConsoleEventToAssistantProcess(assistantProcess, {
              requestId: processRequestId,
              type: "tool-call",
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              input: chunk.input,
              timestamp
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

            const timestamp = new Date().toISOString();
            toolTrace = recordToolCallSettled(toolTrace, {
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              input: chunk.input,
              output: output?.data,
              error: output?.error,
              success,
              timestamp
            });
            assistantProcess = applyConsoleEventToAssistantProcess(assistantProcess, {
              requestId: processRequestId,
              type: "tool-result",
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              input: chunk.input,
              output: output?.data,
              error: output?.error,
              success,
              timestamp
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
            if (isConversationAbortError(chunk.error) || input.abortSignal?.aborted) {
              streamFailed = true;
              streamAborted = true;
              lastStreamError = lastStreamError || "LLM 回复已中断。";
              break;
            }

            toolFailed = true;
            const errorMessage = normalizeErrorMessage(chunk.error, "工具调用失败");
            lastToolError = errorMessage.trim() || lastToolError;
            const timestamp = new Date().toISOString();
            toolTrace = recordToolCallSettled(toolTrace, {
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              input: chunk.input,
              success: false,
              error: errorMessage,
              timestamp
            });
            assistantProcess = applyConsoleEventToAssistantProcess(assistantProcess, {
              requestId: processRequestId,
              type: "tool-result",
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              input: chunk.input,
              success: false,
              error: errorMessage,
              timestamp
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
            if (isAbortLikeError(chunk.error) || input.abortSignal?.aborted) {
              streamFailed = true;
              streamAborted = true;
              lastStreamError = lastStreamError || "LLM 回复已中断。";
              continue;
            }

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
      } catch (error) {
        if (isConversationAbortError(error) || isAbortLikeError(error) || input.abortSignal?.aborted) {
          streamFailed = true;
          streamAborted = true;
          lastStreamError = lastStreamError || "LLM 回复已中断。";
        } else {
          throw error;
        }
      }
    } finally {
      const trailingVisibleDelta = visibleStripper.flush();
      if (trailingVisibleDelta) {
        assistantProcess = applyConsoleEventToAssistantProcess(assistantProcess, {
          requestId: processRequestId,
          type: "text-delta",
          delta: trailingVisibleDelta,
          timestamp: new Date().toISOString()
        });
        input.stream?.onVisibleTextDelta?.(trailingVisibleDelta);
      }
      input.stream?.onThinkingChange?.("stop");
    }

    const visibleText = stripEmotionTags(fullText).trim();
    const finalizedAt = new Date().toISOString();
    const finalizedToolTrace = finalizeToolTraceItems(
      toolTrace,
      streamFailed ? (streamAborted ? "aborted" : "failed") : "completed",
      finalizedAt
    );
    assistantProcess = applyConsoleEventToAssistantProcess(
      assistantProcess,
      streamFailed && !streamAborted
        ? {
            requestId: processRequestId,
            type: "error",
            message: lastStreamError || "LLM 调用失败，请稍后重试。",
            timestamp: finalizedAt
          }
        : streamAborted
          ? {
              requestId: processRequestId,
              type: "final",
              finishReason: "aborted",
              timestamp: finalizedAt
            }
          : {
              requestId: processRequestId,
              type: "final",
              finishReason: "completed",
              rawText: fullText,
              displayText: stripEmotionTags(fullText).trim(),
              timestamp: finalizedAt
            }
    );
    const persistedToolTrace = toPersistedToolTraceItems(finalizedToolTrace);
    const persistedAssistantTimeline = toPersistedAssistantTimelineBlocks(assistantProcess.blocks);
    const toolTraceMetadata =
      persistedToolTrace.length > 0
        ? {
            toolTrace: {
              items: persistedToolTrace
            }
          }
        : undefined;
    if (streamAborted) {
      input.stream?.onAbortVisibleText?.(visibleText);
      const assistantTimelineMetadata = createAssistantTimelineMetadata(
        ensureTimelineHasTrailingText(persistedAssistantTimeline, visibleText)
      );
      if (input.assistantPersistence !== "caller" && (visibleText || toolTraceMetadata)) {
        await this.memory.rememberMessage({
          threadId: input.threadId,
          resourceId: input.resourceId,
          role: "assistant",
          text: visibleText,
          metadata: {
            channel: input.channel,
            ...(toolTraceMetadata ?? {}),
            ...(assistantTimelineMetadata ?? {})
          }
        });
      }

      throw new ConversationAbortError(lastStreamError || "LLM 回复已中断。");
    }

    const trimmedText = visibleText;
    if (streamFailed) {
      const failureText = lastStreamError || "LLM 调用失败，请稍后重试。";
      const assistantTimelineMetadata = createAssistantTimelineMetadata([
        ...getToolOnlyTimelineBlocks(persistedAssistantTimeline),
        { type: "text", text: failureText }
      ]);
      if (input.assistantPersistence !== "caller" && toolTraceMetadata) {
        await this.memory.rememberMessage({
          threadId: input.threadId,
          resourceId: input.resourceId,
          role: "assistant",
          text: failureText,
          metadata: {
            channel: input.channel,
            ...toolTraceMetadata,
            ...(assistantTimelineMetadata ?? {})
          }
        });
      }
      throw new Error(failureText);
    }

    if (!trimmedText && toolFailed) {
      const failureText = lastToolError ? `工具调用失败：${lastToolError}` : "工具调用失败，请稍后重试。";
      const assistantTimelineMetadata = createAssistantTimelineMetadata([
        ...getToolOnlyTimelineBlocks(persistedAssistantTimeline),
        { type: "text", text: failureText }
      ]);
      if (input.assistantPersistence !== "caller" && toolTraceMetadata) {
        await this.memory.rememberMessage({
          threadId: input.threadId,
          resourceId: input.resourceId,
          role: "assistant",
          text: failureText,
          metadata: {
            channel: input.channel,
            ...toolTraceMetadata,
            ...(assistantTimelineMetadata ?? {})
          }
        });
      }
      throw new Error(failureText);
    }

    const fallbackReply = "我这次没有生成有效回复，请重试一次。";
    const rawFinalText = fullText.trim() || fallbackReply;
    const parsedReply = extractEmotionTag(rawFinalText);
    const rawSignalsTag = extractRawSignalsTag(rawFinalText);
    const finalText = parsedReply.cleanedText.trim() || fallbackReply;

    if (parsedReply.signals) {
      logger.info("conversation", "signals-valid", {
        rawSignalsTag,
        parsedSignals: parsedReply.signals
      });
    } else if (rawSignalsTag) {
      logger.warn("conversation", "signals-invalid", {
        rawSignalsTag
      });
    } else {
      logger.warn("conversation", "signals-missing", {
        replyTail: rawFinalText.slice(-220)
      });
    }

    if (parsedReply.signals) {
      await this.onRealtimeEmotionalSignals?.(parsedReply.signals);
    }

    input.stream?.onVisibleTextFinal?.(finalText);

    const assistantTimelineMetadata = createAssistantTimelineMetadata(
      ensureTimelineHasTrailingText(persistedAssistantTimeline, finalText)
    );

    if (input.assistantPersistence !== "caller") {
      await this.memory.rememberMessage({
        threadId: input.threadId,
        resourceId: input.resourceId,
        role: "assistant",
        text: finalText,
        metadata: {
          channel: input.channel,
          ...(toolTraceMetadata ?? {}),
          ...(assistantTimelineMetadata ?? {})
        }
      });
    }

    void result.totalUsage
      .then((totalUsage) => {
        reportTokenUsage({
          source: tokenSourceFromChannel(input.channel),
          usage: totalUsage,
          systemText: system,
          inputText: normalizedText || attachments.map((attachment) => attachment.filename).join(", "),
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
