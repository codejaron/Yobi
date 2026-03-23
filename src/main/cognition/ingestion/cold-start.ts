import { randomUUID } from "node:crypto";
import {
  DEFAULT_COGNITION_CONFIG,
  type CognitionConfig,
  type MemoryEdge,
  type MemoryNode
} from "@shared/cognition";
import type { CompanionPaths } from "@main/storage/paths";
import { MemoryGraphStore } from "../graph/memory-graph";
import { FIXED_USER_PERSON_ID, FIXED_YOBI_PERSON_ID, ensureFixedPersonNodes } from "./graph-adapter";

interface ColdStartSeedDraft {
  nodes: Array<{
    content: string;
    type: Extract<MemoryNode["type"], "concept" | "emotion_anchor" | "time_marker" | "intent" | "person">;
    emotional_valence?: number;
  }>;
  edges: Array<{
    source_content: string;
    target_content: string;
    type: Extract<MemoryEdge["relation_type"], "semantic" | "temporal" | "causal" | "emotional">;
  }>;
}

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

function sortTimeMarkerNodes(nodes: MemoryNode[]): MemoryNode[] {
  const order = ["凌晨", "清晨", "早上", "上午", "中午", "午饭时间", "下午", "傍晚", "晚上", "夜里", "深夜"];
  return [...nodes].sort((left, right) => {
    const leftIndex = order.indexOf(left.content);
    const rightIndex = order.indexOf(right.content);
    const normalizedLeft = leftIndex >= 0 ? leftIndex : Number.MAX_SAFE_INTEGER;
    const normalizedRight = rightIndex >= 0 ? rightIndex : Number.MAX_SAFE_INTEGER;
    if (normalizedLeft !== normalizedRight) {
      return normalizedLeft - normalizedRight;
    }
    return left.content.localeCompare(right.content);
  });
}

function addEdgeIfMissing(input: {
  graph: MemoryGraphStore;
  sourceId: string;
  targetId: string;
  relationType: MemoryEdge["relation_type"];
  weight: number;
  nowMs: number;
}): void {
  if (input.sourceId === input.targetId) {
    return;
  }

  const existing = input.graph.getEdgesBetween(input.sourceId, input.targetId).find((edge) => edge.relation_type === input.relationType);
  if (existing) {
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

export async function runColdStart(input: {
  paths: CompanionPaths;
  graph: MemoryGraphStore;
  soulMarkdown: string;
  cognitionConfig?: CognitionConfig;
  nowMs?: number;
  embedText: (text: string) => Promise<number[] | null>;
  generateSeeds: (input: {
    soulMarkdown: string;
    targetNodeCount: number;
  }) => Promise<ColdStartSeedDraft>;
}): Promise<{ created: boolean; nodeCount: number; edgeCount: number }> {
  const cognitionConfig = input.cognitionConfig ?? DEFAULT_COGNITION_CONFIG;
  if (input.graph.getStatistics().nodeCount > 0) {
    const stats = input.graph.getStatistics();
    return {
      created: false,
      nodeCount: stats.nodeCount,
      edgeCount: stats.edgeCount
    };
  }

  const nowMs = input.nowMs ?? Date.now();
  await ensureFixedPersonNodes({
    graph: input.graph,
    embedText: input.embedText,
    nowMs
  });

  const targetNodeCount = Math.max(5, cognitionConfig.cold_start.seed_node_count - 2);
  const draft = await input.generateSeeds({
    soulMarkdown: input.soulMarkdown,
    targetNodeCount
  });
  const contentToId = new Map<string, string>([
    ["用户", FIXED_USER_PERSON_ID],
    ["Yobi", FIXED_YOBI_PERSON_ID]
  ]);

  for (const node of draft.nodes) {
    const content = normalizeText(node.content);
    if (!content || contentToId.has(content)) {
      continue;
    }

    const created = input.graph.addNode(
      {
        id: randomUUID(),
        content,
        type: node.type,
        embedding: (await input.embedText(content)) ?? [],
        activation_level: 0,
        activation_history: [],
        base_level_activation: Number.NEGATIVE_INFINITY,
        emotional_valence: node.emotional_valence ?? 0,
        created_at: nowMs,
        last_activated_at: nowMs,
        metadata: {
          extracted_from: "cold_start"
        }
      },
      {
        skipDuplicateDetection: true
      }
    );
    contentToId.set(content, created.id);
  }

  for (const edge of draft.edges) {
    const sourceId = contentToId.get(normalizeText(edge.source_content));
    const targetId = contentToId.get(normalizeText(edge.target_content));
    if (!sourceId || !targetId) {
      continue;
    }
    addEdgeIfMissing({
      graph: input.graph,
      sourceId,
      targetId,
      relationType: edge.type,
      weight: cognitionConfig.cold_start.initial_edge_weight,
      nowMs
    });
  }

  const allNodes = input.graph.getAllNodes();
  for (let index = 0; index < allNodes.length; index += 1) {
    const left = allNodes[index];
    if (left.type === "person") {
      continue;
    }
    for (let inner = index + 1; inner < allNodes.length; inner += 1) {
      const right = allNodes[inner];
      if (left.type !== right.type) {
        continue;
      }
      if (cosineSimilarity(left.embedding, right.embedding) <= cognitionConfig.cold_start.semantic_edge_threshold) {
        continue;
      }

      addEdgeIfMissing({
        graph: input.graph,
        sourceId: left.id,
        targetId: right.id,
        relationType: "semantic",
        weight: cognitionConfig.cold_start.initial_edge_weight,
        nowMs
      });
      addEdgeIfMissing({
        graph: input.graph,
        sourceId: right.id,
        targetId: left.id,
        relationType: "semantic",
        weight: cognitionConfig.cold_start.initial_edge_weight,
        nowMs
      });
    }
  }

  const timeNodes = sortTimeMarkerNodes(allNodes.filter((node) => node.type === "time_marker"));
  for (let index = 0; index < timeNodes.length - 1; index += 1) {
    addEdgeIfMissing({
      graph: input.graph,
      sourceId: timeNodes[index]!.id,
      targetId: timeNodes[index + 1]!.id,
      relationType: "temporal",
      weight: cognitionConfig.cold_start.initial_edge_weight,
      nowMs
    });
  }

  const emotionNodes = allNodes.filter((node) => node.type === "emotion_anchor");
  const conceptNodes = allNodes.filter((node) => node.type === "concept");
  for (const emotionNode of emotionNodes) {
    for (const conceptNode of conceptNodes) {
      if (cosineSimilarity(emotionNode.embedding, conceptNode.embedding) <= 0) {
        continue;
      }
      addEdgeIfMissing({
        graph: input.graph,
        sourceId: emotionNode.id,
        targetId: conceptNode.id,
        relationType: "emotional",
        weight: cognitionConfig.cold_start.initial_edge_weight,
        nowMs
      });
    }
  }

  const stats = input.graph.getStatistics();
  return {
    created: true,
    nodeCount: stats.nodeCount,
    edgeCount: stats.edgeCount
  };
}
