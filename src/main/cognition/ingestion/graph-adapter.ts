import { randomUUID } from "node:crypto";
import type { Fact } from "@shared/types";
import {
  DEFAULT_COGNITION_CONFIG,
  type CognitionConfig,
  type CombinedDialogueExtractionDraft,
  type MemoryEdge,
  type MemoryNode
} from "@shared/cognition";
import { readJsonFile, writeJsonFileAtomic } from "@main/storage/fs";
import type { CompanionPaths } from "@main/storage/paths";
import { MemoryGraphStore } from "../graph/memory-graph";

const TIME_MARKER_TERMS = new Set([
  "凌晨",
  "清晨",
  "早上",
  "上午",
  "中午",
  "午饭时间",
  "下午",
  "傍晚",
  "晚上",
  "夜里",
  "深夜",
  "周末",
  "工作日"
]);

const EMOTION_ANCHOR_TERMS = new Set([
  "开心",
  "高兴",
  "平静",
  "安心",
  "好奇",
  "期待",
  "担心",
  "难过",
  "失落",
  "疲惫",
  "生气",
  "烦躁"
]);

export const FIXED_USER_PERSON_ID = "person:user";
export const FIXED_YOBI_PERSON_ID = "person:yobi";

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm <= 0 || rightNorm <= 0) {
    return 0;
  }

  return dot / Math.sqrt(leftNorm * rightNorm);
}

function normalizeText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function mergeStringSets(...values: Array<unknown>): string[] {
  const merged = new Set<string>();
  for (const value of values) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const item of value) {
      if (typeof item !== "string") {
        continue;
      }
      const normalized = normalizeText(item);
      if (normalized) {
        merged.add(normalized);
      }
    }
  }
  return [...merged];
}

function mergeActivationHistory(left: number[], right: number[], nowMs: number): number[] {
  return [...new Set([...left, ...right, nowMs])].sort((a, b) => a - b);
}

function preferredContent(left: string, right: string): string {
  if (right.length > left.length) {
    return right;
  }
  return left;
}

function normalizePlaceholders(
  raw: string,
  cognitionConfig: CognitionConfig
): string {
  return normalizeText(raw)
    .replaceAll(cognitionConfig.ingestion.user_placeholder, "用户")
    .replaceAll(cognitionConfig.ingestion.yobi_placeholder, "Yobi");
}

function resolveReservedPersonId(
  raw: string,
  cognitionConfig: CognitionConfig
): string | null {
  const normalized = normalizeText(raw);
  if (
    normalized === cognitionConfig.ingestion.user_placeholder ||
    normalized === "用户"
  ) {
    return FIXED_USER_PERSON_ID;
  }
  if (
    normalized === cognitionConfig.ingestion.yobi_placeholder ||
    normalized === "Yobi"
  ) {
    return FIXED_YOBI_PERSON_ID;
  }
  return null;
}

function inferNodeType(
  rawType: CombinedDialogueExtractionDraft["graph"]["nodes"][number]["type"],
  content: string
): MemoryNode["type"] {
  if (rawType === "person") {
    return "person";
  }

  if (TIME_MARKER_TERMS.has(content)) {
    return "time_marker";
  }

  if (EMOTION_ANCHOR_TERMS.has(content)) {
    return "emotion_anchor";
  }

  return rawType;
}

function makeNode(input: {
  id: string;
  content: string;
  type: MemoryNode["type"];
  embedding: number[];
  emotionalValence: number;
  nowMs: number;
  metadata?: Record<string, unknown>;
}): MemoryNode {
  return {
    id: input.id,
    content: input.content,
    type: input.type,
    embedding: input.embedding,
    activation_level: 0,
    activation_history: input.type === "person" ? [] : [input.nowMs],
    base_level_activation: Number.NEGATIVE_INFINITY,
    emotional_valence: input.emotionalValence,
    created_at: input.nowMs,
    last_activated_at: input.nowMs,
    metadata: input.metadata ?? {}
  };
}

async function persistLegacyFacts(paths: CompanionPaths, facts: string[]): Promise<void> {
  if (facts.length === 0) {
    return;
  }

  const existing = await readJsonFile<string[]>(paths.factsPath, []);
  const merged = new Set<string>(
    existing
      .filter((value): value is string => typeof value === "string")
      .map((value) => normalizeText(value))
      .filter(Boolean)
  );
  for (const fact of facts) {
    const normalized = normalizeText(fact);
    if (normalized) {
      merged.add(normalized);
    }
  }

  await writeJsonFileAtomic(paths.factsPath, [...merged]);
}

function selectBestTypedMatch(input: {
  graph: MemoryGraphStore;
  type: MemoryNode["type"];
  embedding: number[];
  threshold: number;
}): MemoryNode | null {
  let best: { node: MemoryNode; score: number } | null = null;
  for (const candidate of input.graph.getAllNodes()) {
    if (candidate.type !== input.type || candidate.type === "person") {
      continue;
    }
    const score = cosineSimilarity(candidate.embedding, input.embedding);
    if (score < input.threshold) {
      continue;
    }
    if (!best || score > best.score) {
      best = {
        node: candidate,
        score
      };
    }
  }
  return best?.node ?? null;
}

function selectPersonMatch(graph: MemoryGraphStore, content: string): MemoryNode | null {
  const normalized = normalizeText(content);
  for (const candidate of graph.getAllNodes()) {
    if (candidate.type !== "person") {
      continue;
    }
    if (normalizeText(candidate.content) === normalized) {
      return candidate;
    }
    const aliases = mergeStringSets(candidate.metadata.aliases);
    if (aliases.includes(normalized)) {
      return candidate;
    }
  }
  return null;
}

function mergeNodeState(input: {
  target: MemoryNode;
  incoming: {
    content: string;
    embedding: number[];
    emotionalValence: number;
    nowMs: number;
    metadata?: Record<string, unknown>;
  };
}): MemoryNode {
  const aliases = mergeStringSets(
    input.target.metadata.aliases,
    input.incoming.metadata?.aliases
  );
  const currentReinforcement = typeof input.target.metadata.reinforcement_count === "number"
    ? Number(input.target.metadata.reinforcement_count)
    : 0;
  const incomingReinforcement = typeof input.incoming.metadata?.reinforcement_count === "number"
    ? Number(input.incoming.metadata.reinforcement_count)
    : 1;
  return {
    ...input.target,
    content: preferredContent(input.target.content, input.incoming.content),
    embedding: input.incoming.embedding.length > 0 ? input.incoming.embedding : input.target.embedding,
    emotional_valence: input.incoming.content.length >= input.target.content.length
      ? input.incoming.emotionalValence
      : input.target.emotional_valence,
    activation_history: mergeActivationHistory(
      input.target.activation_history,
      [],
      input.incoming.nowMs
    ),
    last_activated_at: input.incoming.nowMs,
    metadata: {
      ...input.target.metadata,
      ...(input.incoming.metadata ?? {}),
      ...(aliases.length > 0 ? { aliases } : {}),
      reinforcement_count: currentReinforcement + incomingReinforcement
    }
  };
}

function upsertEdge(input: {
  graph: MemoryGraphStore;
  sourceId: string;
  targetId: string;
  relationType: MemoryEdge["relation_type"];
  nowMs: number;
  weight: number;
  mode: "increment" | "preserve-max";
}): void {
  if (input.sourceId === input.targetId) {
    return;
  }

  const existing = input.graph.getEdgesBetween(input.sourceId, input.targetId).find((edge) => edge.relation_type === input.relationType);
  if (existing) {
    const nextWeight = input.mode === "increment"
      ? Math.min(1, existing.weight + input.weight)
      : Math.max(existing.weight, input.weight);
    input.graph.addEdge({
      ...existing,
      weight: nextWeight,
      last_activated_at: input.nowMs
    });
    return;
  }

  input.graph.addEdge({
    id: randomUUID(),
    source: input.sourceId,
    target: input.targetId,
    relation_type: input.relationType,
    weight: input.weight,
    created_at: input.nowMs,
    last_activated_at: input.nowMs
  });
}

function mergeNodeIds(input: {
  graph: MemoryGraphStore;
  sourceId: string;
  targetId: string;
  nowMs: number;
}): boolean {
  if (input.sourceId === input.targetId) {
    return false;
  }

  const sourceNode = input.graph.getNode(input.sourceId);
  const targetNode = input.graph.getNode(input.targetId);
  if (!sourceNode || !targetNode) {
    return false;
  }

  const nextTarget: MemoryNode = {
    ...targetNode,
    activation_history: mergeActivationHistory(
      targetNode.activation_history,
      sourceNode.activation_history,
      input.nowMs
    ),
    created_at: Math.min(targetNode.created_at, sourceNode.created_at),
    last_activated_at: Math.max(targetNode.last_activated_at, sourceNode.last_activated_at, input.nowMs),
    metadata: {
      ...sourceNode.metadata,
      ...targetNode.metadata,
      aliases: mergeStringSets(
        targetNode.metadata.aliases,
        sourceNode.metadata.aliases,
        [sourceNode.content]
      ),
      reinforcement_count:
        (typeof targetNode.metadata.reinforcement_count === "number"
          ? Number(targetNode.metadata.reinforcement_count)
          : 0) +
        (typeof sourceNode.metadata.reinforcement_count === "number"
          ? Number(sourceNode.metadata.reinforcement_count)
          : 0)
    }
  };
  input.graph.replaceNode(nextTarget);

  const rewrittenEdges = input.graph
    .getAllEdges()
    .filter((edge) => edge.source === input.sourceId || edge.target === input.sourceId)
    .map((edge) => ({
      ...edge,
      source: edge.source === input.sourceId ? input.targetId : edge.source,
      target: edge.target === input.sourceId ? input.targetId : edge.target
    }));

  input.graph.removeNodes([input.sourceId]);
  for (const edge of rewrittenEdges) {
    upsertEdge({
      graph: input.graph,
      sourceId: edge.source,
      targetId: edge.target,
      relationType: edge.relation_type,
      nowMs: input.nowMs,
      weight: edge.weight,
      mode: "preserve-max"
    });
  }

  return true;
}

export async function ensureFixedPersonNodes(input: {
  graph: MemoryGraphStore;
  embedText?: (text: string) => Promise<number[] | null>;
  nowMs?: number;
}): Promise<void> {
  const nowMs = input.nowMs ?? Date.now();
  if (!input.graph.getNode(FIXED_USER_PERSON_ID)) {
    input.graph.addNode(
      makeNode({
        id: FIXED_USER_PERSON_ID,
        content: "用户",
        type: "person",
        embedding: input.embedText ? ((await input.embedText("用户")) ?? []) : [],
        emotionalValence: 0,
        nowMs,
        metadata: {
          person_ref: "user",
          aliases: []
        }
      }),
      {
        skipDuplicateDetection: true
      }
    );
  }
  if (!input.graph.getNode(FIXED_YOBI_PERSON_ID)) {
    input.graph.addNode(
      makeNode({
        id: FIXED_YOBI_PERSON_ID,
        content: "Yobi",
        type: "person",
        embedding: input.embedText ? ((await input.embedText("Yobi")) ?? []) : [],
        emotionalValence: 0,
        nowMs,
        metadata: {
          person_ref: "yobi",
          aliases: []
        }
      }),
      {
        skipDuplicateDetection: true
      }
    );
  }
}

export async function applyCombinedExtraction(input: {
  paths: CompanionPaths;
  graph: MemoryGraphStore;
  channel: string;
  draft: CombinedDialogueExtractionDraft;
  memory: {
    embedText: (text: string) => Promise<number[] | null>;
    getFactsStore: () => {
      applyOperations: (
        operations: CombinedDialogueExtractionDraft["fact_operations"],
        source?: string
      ) => Promise<Fact[]>;
    };
    syncFactEmbeddings: (facts: Fact[]) => Promise<void>;
  };
  cognitionConfig?: CognitionConfig;
  nowMs?: number;
}): Promise<void> {
  const cognitionConfig = input.cognitionConfig ?? DEFAULT_COGNITION_CONFIG;
  const nowMs = input.nowMs ?? Date.now();
  await ensureFixedPersonNodes({
    graph: input.graph,
    embedText: input.memory.embedText,
    nowMs
  });

  await persistLegacyFacts(input.paths, input.draft.facts);
  if (input.draft.fact_operations.length > 0) {
    const changedFacts = await input.memory.getFactsStore().applyOperations(
      input.draft.fact_operations,
      "cognition-ingestion"
    );
    await input.memory.syncFactEmbeddings(changedFacts);
  }

  const contentToId = new Map<string, string>([
    [cognitionConfig.ingestion.user_placeholder, FIXED_USER_PERSON_ID],
    [cognitionConfig.ingestion.yobi_placeholder, FIXED_YOBI_PERSON_ID],
    ["用户", FIXED_USER_PERSON_ID],
    ["Yobi", FIXED_YOBI_PERSON_ID]
  ]);

  for (const draftNode of input.draft.graph.nodes) {
    const rawContent = normalizeText(draftNode.content);
    const normalizedContent = normalizePlaceholders(rawContent, cognitionConfig);
    const reservedPersonId = draftNode.type === "person"
      ? resolveReservedPersonId(rawContent, cognitionConfig)
      : null;
    if (reservedPersonId) {
      contentToId.set(rawContent, reservedPersonId);
      contentToId.set(normalizedContent, reservedPersonId);
      continue;
    }

    const nextType = inferNodeType(draftNode.type, normalizedContent);
    const embedding = (await input.memory.embedText(normalizedContent)) ?? [];
    const existing = nextType === "person"
      ? selectPersonMatch(input.graph, normalizedContent)
      : selectBestTypedMatch({
          graph: input.graph,
          type: nextType,
          embedding,
          threshold: cognitionConfig.ingestion.merge_cosine_threshold
        });

    if (existing) {
      const merged = mergeNodeState({
        target: existing,
        incoming: {
          content: normalizedContent,
          embedding,
          emotionalValence: draftNode.emotional_valence ?? 0,
          nowMs,
          metadata: nextType === "person" && existing.content !== normalizedContent
            ? { aliases: [normalizedContent] }
            : undefined
        }
      });
      input.graph.replaceNode(merged);
      contentToId.set(rawContent, existing.id);
      contentToId.set(normalizedContent, existing.id);
      continue;
    }

    const created = input.graph.addNode(
      makeNode({
        id: randomUUID(),
        content: normalizedContent,
        type: nextType,
        embedding,
        emotionalValence: draftNode.emotional_valence ?? 0,
        nowMs,
        metadata: {
          channel: input.channel,
          extracted_from: "combined_ingestion",
          reinforcement_count: nextType === "person" ? 0 : 1
        }
      }),
      {
        skipDuplicateDetection: true
      }
    );
    contentToId.set(rawContent, created.id);
    contentToId.set(normalizedContent, created.id);
  }

  for (const edge of input.draft.graph.edges) {
    const sourceId = contentToId.get(normalizeText(edge.source_content))
      ?? contentToId.get(normalizePlaceholders(edge.source_content, cognitionConfig));
    const targetId = contentToId.get(normalizeText(edge.target_content))
      ?? contentToId.get(normalizePlaceholders(edge.target_content, cognitionConfig));
    if (!sourceId || !targetId) {
      continue;
    }

    upsertEdge({
      graph: input.graph,
      sourceId,
      targetId,
      relationType: edge.type,
      nowMs,
      weight: input.graph.getEdgesBetween(sourceId, targetId).some((candidate) => candidate.relation_type === edge.type)
        ? cognitionConfig.ingestion.edge_weight_increment
        : cognitionConfig.cold_start.initial_edge_weight,
      mode: "increment"
    });
  }

  for (const merge of input.draft.graph.entity_merges) {
    const sourceId = contentToId.get(normalizeText(merge.source_content))
      ?? contentToId.get(normalizePlaceholders(merge.source_content, cognitionConfig))
      ?? selectPersonMatch(input.graph, normalizePlaceholders(merge.source_content, cognitionConfig))?.id;
    const targetId = contentToId.get(normalizeText(merge.target_content))
      ?? contentToId.get(normalizePlaceholders(merge.target_content, cognitionConfig))
      ?? selectPersonMatch(input.graph, normalizePlaceholders(merge.target_content, cognitionConfig))?.id;
    if (!sourceId || !targetId) {
      continue;
    }
    mergeNodeIds({
      graph: input.graph,
      sourceId,
      targetId,
      nowMs
    });
  }
}
