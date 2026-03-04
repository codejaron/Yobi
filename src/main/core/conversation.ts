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
import type { StateStore } from "@main/kernel/state-store";
import { CompanionPaths } from "@main/storage/paths";

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

function parseDeltaTag(text: string): {
  cleanedText: string;
  delta: Partial<Record<"mood" | "energy" | "connection" | "curiosity" | "confidence" | "irritation", number>>;
} {
  const pattern = /<delta\s+([^>]+?)\s*\/>/gi;
  const matches = Array.from(text.matchAll(pattern));
  if (matches.length === 0) {
    return {
      cleanedText: text,
      delta: {}
    };
  }

  const latest = matches[matches.length - 1]?.[1] ?? "";
  const attrs = parseDeltaAttributes(latest);
  return {
    cleanedText: text.replace(pattern, ""),
    delta: attrs
  };
}

function parseDeltaAttributes(raw: string): Partial<Record<"mood" | "energy" | "connection" | "curiosity" | "confidence" | "irritation", number>> {
  const output: Partial<Record<"mood" | "energy" | "connection" | "curiosity" | "confidence" | "irritation", number>> = {};
  const keys: Array<keyof typeof output> = [
    "mood",
    "energy",
    "connection",
    "curiosity",
    "confidence",
    "irritation"
  ];
  for (const key of keys) {
    const matched = new RegExp(`${key}\\s*=\\s*"([+-]?\\d+(?:\\.\\d+)?)"`).exec(raw);
    if (!matched) {
      continue;
    }
    const value = Number(matched[1]);
    if (!Number.isFinite(value)) {
      continue;
    }
    output[key] = Math.max(-0.2, Math.min(0.2, value));
  }
  return output;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
    const assembled = assembleContext({
      soul: soul.trim(),
      persona: persona.trim(),
      stage: stateSnapshot.relationship.stage,
      state: stateSnapshot,
      profile,
      buffer,
      facts,
      episodes,
      maxTokens: Math.min(24_000, Math.max(4_000, config.openclaw.contextTokens || 8_000))
    });

    const system = [
      assembled.system,
      input.photoUrl ? `\n用户这轮附带图片 URL: ${input.photoUrl}` : "",
      "回复可选在末尾附带 <delta mood=\"+0.05\" energy=\"-0.02\" connection=\"+0.10\"/> 作为状态变化建议。"
    ]
      .filter(Boolean)
      .join("\n\n");

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
    const parsedDelta = parseDeltaTag(rawFinalText);
    const textWithoutDelta = parsedDelta.cleanedText.trim() || fallbackReply;
    const finalText = stripEmotionTags(textWithoutDelta).trim() || fallbackReply;

    await this.memory.rememberMessage({
      threadId: input.threadId,
      resourceId: input.resourceId,
      role: "assistant",
      text: finalText,
      metadata: {
        channel: input.channel
      }
    });

    this.applyDeltaSuggestion(parsedDelta.delta);

    try {
      const totalUsage = await result.totalUsage;
      reportTokenUsage({
        source: tokenSourceFromChannel(input.channel),
        usage: totalUsage,
        systemText: system,
        inputText: normalizedText,
        outputText: textWithoutDelta
      });
    } catch (error) {
      console.warn("[conversation] token usage capture failed:", error);
    }

    return textWithoutDelta;
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

  private applyDeltaSuggestion(
    delta: Partial<Record<"mood" | "energy" | "connection" | "curiosity" | "confidence" | "irritation", number>>
  ): void {
    if (Object.keys(delta).length === 0) {
      return;
    }
    this.stateStore.mutate((state) => {
      if (typeof delta.mood === "number") {
        state.emotional.mood = clamp(state.emotional.mood + delta.mood, -1, 1);
      }
      if (typeof delta.energy === "number") {
        state.emotional.energy = clamp(state.emotional.energy + delta.energy, 0, 1);
      }
      if (typeof delta.connection === "number") {
        state.emotional.connection = clamp(state.emotional.connection + delta.connection, 0, 1);
      }
      if (typeof delta.curiosity === "number") {
        state.emotional.curiosity = clamp(state.emotional.curiosity + delta.curiosity, 0, 1);
      }
      if (typeof delta.confidence === "number") {
        state.emotional.confidence = clamp(state.emotional.confidence + delta.confidence, 0, 1);
      }
      if (typeof delta.irritation === "number") {
        state.emotional.irritation = clamp(state.emotional.irritation + delta.irritation, 0, 1);
      }
    });
  }
}
