import { generateObject } from "ai";
import { z } from "zod";
import type { AppConfig, BufferMessage, FactCategory, FactTtlClass } from "@shared/types";
import { resolveOpenAIStoreOption } from "@main/core/provider-utils";
import type { ModelFactory } from "@main/core/model-factory";
import { reportTokenUsage } from "@main/services/token/token-usage-reporter";

const factDraftSchema = z.object({
  entity: z.string().min(1).max(80),
  key: z.string().min(1).max(80),
  value: z.string().min(1).max(400),
  category: z
    .enum(["identity", "preference", "event", "goal", "relationship", "emotion_pattern"])
    .default("event"),
  confidence: z.number().min(0).max(1).default(0.65),
  ttl_class: z.enum(["permanent", "stable", "active", "session"]).default("stable"),
  source: z.string().max(120).optional(),
  source_range: z.string().max(120).optional()
});

const factOperationSchema = z.object({
  action: z.enum(["add", "update", "supersede"]),
  fact: factDraftSchema
});

const emotionalSignalsSchema = z
  .object({
    user_mood: z.enum(["positive", "neutral", "negative", "mixed"]).default("neutral"),
    engagement: z.number().min(0).max(1).default(0.5),
    trust_delta: z.number().min(-0.3).max(0.3).default(0),
    friction: z.boolean().default(false),
    curiosity_trigger: z.boolean().default(false)
  })
  .strict();

const extractionSchema = z.object({
  operations: z.array(factOperationSchema).max(60).default([]),
  emotional_signals: emotionalSignalsSchema.optional()
});

const extractionOperationsSchema = z.object({
  operations: z.array(factOperationSchema).max(60).default([])
});

export interface FactOperationOutput {
  action: "add" | "update" | "supersede";
  fact: {
    entity: string;
    key: string;
    value: string;
    category: FactCategory;
    confidence: number;
    ttl_class: FactTtlClass;
    source?: string;
    source_range?: string;
  };
}

export interface ExtractionChunk {
  sourceRange: string;
  messages: BufferMessage[];
}

export type EmotionalSignals = z.infer<typeof emotionalSignalsSchema>;

export interface FactExtractionOutput {
  operations: FactOperationOutput[];
  emotionalSignals?: EmotionalSignals;
  tokenUsage?: unknown;
}

export function estimateTokenCount(text: string): number {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }

  const cjkChars = (normalized.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latinWords = normalized.match(/[A-Za-z0-9_]+/g)?.length ?? 0;
  const punctuation = (normalized.match(/[，。！？、,.!?;:()[\]{}"“”‘’`~]/g) ?? []).length;
  return Math.max(1, Math.ceil(cjkChars * 1.2 + latinWords * 0.35 + punctuation * 0.2));
}

export function splitExtractionWindows(input: {
  messages: BufferMessage[];
  maxInputTokens: number;
}): ExtractionChunk[] {
  const maxTokens = Math.max(256, input.maxInputTokens);
  const chunks: ExtractionChunk[] = [];
  let cursor: BufferMessage[] = [];
  let currentTokens = 0;
  for (const message of input.messages) {
    const line = `${message.role}:${message.text}`;
    const tokens = estimateTokenCount(line) + 16;
    if (cursor.length > 0 && currentTokens + tokens > maxTokens) {
      chunks.push({
        sourceRange: makeRange(cursor[0]?.id, cursor[cursor.length - 1]?.id),
        messages: [...cursor]
      });
      cursor = [];
      currentTokens = 0;
    }
    cursor.push(message);
    currentTokens += tokens;
  }

  if (cursor.length > 0) {
    chunks.push({
      sourceRange: makeRange(cursor[0]?.id, cursor[cursor.length - 1]?.id),
      messages: [...cursor]
    });
  }

  return chunks;
}

export async function runFactExtraction(input: {
  messages: BufferMessage[];
  existingFacts: unknown;
  profileHint: unknown;
  modelFactory: ModelFactory;
  config: AppConfig;
  maxOutputTokens?: number;
}): Promise<FactExtractionOutput> {
  if (input.messages.length === 0) {
    return {
      operations: []
    };
  }

  const model = input.modelFactory.getFactExtractionModel();
  const system = [
    "你负责从对话片段中提取结构化事实。",
    "你输出 JSON，包含 operations，以及可选的 emotional_signals。",
    "action 仅可为 add / update / supersede。",
    "若无法判断明显情绪信号，emotional_signals 使用 neutral/0.5/0/false/false。",
    "不要复述对话，不要输出解释文本。"
  ].join("\n");
  const prompt = JSON.stringify(
    {
      message_window: input.messages.map((message) => ({
        id: message.id,
        ts: message.ts,
        role: message.role,
        text: message.text
      })),
      existing_facts: input.existingFacts,
      profile_hint: input.profileHint,
      now_iso: new Date().toISOString()
    },
    null,
    2
  );

  const result = await generateObject({
    model,
    providerOptions: resolveOpenAIStoreOption(input.config),
    schema: extractionSchema,
    system,
    prompt,
    maxOutputTokens: Math.max(128, input.maxOutputTokens ?? 800)
  });

  reportTokenUsage({
    source: "background:fact-extraction",
    usage: result.usage,
    systemText: system,
    inputText: prompt,
    outputText: JSON.stringify(result.object ?? {})
  });

  return {
    ...parseExtractionObject(result.object ?? { operations: [] }),
    tokenUsage: result.usage
  };
}

function makeRange(start?: string, end?: string): string {
  const normalizedStart = start?.trim() || "msg-unknown";
  const normalizedEnd = end?.trim() || normalizedStart;
  return `${normalizedStart}..${normalizedEnd}`;
}

export function parseExtractionObject(raw: unknown): FactExtractionOutput {
  const parsedOperations = extractionOperationsSchema.parse(raw);
  const emotionalSignalsResult = emotionalSignalsSchema.safeParse(
    (raw as Record<string, unknown>)?.emotional_signals
  );
  return {
    operations: parsedOperations.operations.map((operation) => ({
      action: operation.action,
      fact: {
        entity: operation.fact.entity.trim(),
        key: operation.fact.key.trim(),
        value: operation.fact.value.trim(),
        category: operation.fact.category,
        confidence: operation.fact.confidence,
        ttl_class: operation.fact.ttl_class,
        source: operation.fact.source,
        source_range: operation.fact.source_range
      }
    })),
    emotionalSignals: emotionalSignalsResult.success ? emotionalSignalsResult.data : undefined
  };
}
