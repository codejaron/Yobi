import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { DEFAULT_COGNITION_CONFIG, type MemoryNode } from "@shared/cognition";
import { CompanionPaths } from "../storage/paths.js";
import { MemoryGraphStore } from "../cognition/graph/memory-graph.js";
import { buildReplyMemoryBlock } from "../cognition/retrieval/memory-retrieval.js";

async function createTempPaths(prefix: string): Promise<CompanionPaths> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const paths = new CompanionPaths(baseDir);
  paths.ensureLayout();
  return paths;
}

async function cleanupPaths(paths: CompanionPaths): Promise<void> {
  await fs.rm(paths.baseDir, { recursive: true, force: true });
}

function makeNode(input: Partial<MemoryNode> & Pick<MemoryNode, "content" | "type" | "embedding">): MemoryNode {
  const now = input.created_at ?? Date.now();
  return {
    id: input.id ?? randomUUID(),
    content: input.content,
    type: input.type,
    embedding: input.embedding,
    activation_level: input.activation_level ?? 0,
    activation_history: input.activation_history ?? [],
    base_level_activation: input.base_level_activation ?? 0,
    emotional_valence: input.emotional_valence ?? 0,
    created_at: now,
    last_activated_at: input.last_activated_at ?? now,
    metadata: input.metadata ?? {}
  };
}

test("buildReplyMemoryBlock filters excluded node types, removes recent repeats, and does not mutate graph state", async () => {
  const paths = await createTempPaths("yobi-cognition-retrieval-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    graph.addNode(makeNode({ id: "seed", content: "用户喜欢热乎的拉面", type: "fact", embedding: [1, 0, 0] }));
    graph.addNode(makeNode({ id: "pressure", content: "用户最近工作压力比较大", type: "concept", embedding: [0, 1, 0] }));
    graph.addNode(makeNode({ id: "time", content: "早上", type: "time_marker", embedding: [0.8, 0.2, 0] }));
    graph.addNode(makeNode({ id: "emotion", content: "开心", type: "emotion_anchor", embedding: [0.75, 0.25, 0] }));
    graph.addEdge({
      id: "edge-a",
      source: "seed",
      target: "pressure",
      relation_type: "semantic",
      weight: 0.8,
      created_at: 1_000,
      last_activated_at: 1_000
    });
    graph.addEdge({
      id: "edge-b",
      source: "seed",
      target: "time",
      relation_type: "temporal",
      weight: 0.8,
      created_at: 1_000,
      last_activated_at: 1_000
    });
    graph.addEdge({
      id: "edge-c",
      source: "pressure",
      target: "emotion",
      relation_type: "emotional",
      weight: 0.8,
      created_at: 1_000,
      last_activated_at: 1_000
    });

    const embeddings = new Map<string, number[]>([
      ["拉面", [1, 0, 0]],
      ["用户喜欢热乎的拉面", [1, 0, 0]],
      ["用户最近工作压力比较大", [0, 1, 0]],
      ["最近一直在吃拉面", [1, 0, 0]]
    ]);
    const before = structuredClone(graph.toJSON());

    const block = await buildReplyMemoryBlock({
      graph,
      userText: "拉面",
      embedText: async (text) => embeddings.get(text) ?? [0, 0, 1],
      getRecentDialogueMessages: async () => ["最近一直在吃拉面"],
      cognitionConfig: DEFAULT_COGNITION_CONFIG
    });

    assert.match(block, /\[你对这个用户的记忆\]/);
    assert.match(block, /用户最近工作压力比较大/);
    assert.doesNotMatch(block, /用户喜欢热乎的拉面/);
    assert.doesNotMatch(block, /早上/);
    assert.doesNotMatch(block, /开心/);
    assert.deepEqual(graph.toJSON(), before);
  } finally {
    await cleanupPaths(paths);
  }
});
