import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { DEFAULT_COGNITION_CONFIG, type MemoryNode } from "@shared/cognition";
import { CompanionPaths } from "../storage/paths.js";
import { MemoryGraphStore } from "../cognition/graph/memory-graph.js";
import { dedupePersonEntities } from "../cognition/consolidation/entity-dedup.js";

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

test("dedupePersonEntities merges person nodes only when similarity and neighbor overlap both pass thresholds", async () => {
  const paths = await createTempPaths("yobi-cognition-person-dedup-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    graph.addNode(makeNode({ id: "person-a", content: "小王", type: "person", embedding: [1, 0, 0], activation_history: [100] }));
    graph.addNode(makeNode({ id: "person-b", content: "王哥", type: "person", embedding: [0.99, 0.01, 0], activation_history: [200] }));
    graph.addNode(makeNode({ id: "person-c", content: "路人甲", type: "person", embedding: [0, 1, 0] }));
    graph.addNode(makeNode({ id: "fact-1", content: "最近换工作了", type: "fact", embedding: [0, 0, 1] }));
    graph.addNode(makeNode({ id: "fact-2", content: "喜欢深夜散步", type: "fact", embedding: [0, 0, 0.9] }));
    graph.addEdge({
      id: "edge-a",
      source: "person-a",
      target: "fact-1",
      relation_type: "semantic",
      weight: 0.5,
      created_at: 1_000,
      last_activated_at: 1_000
    });
    graph.addEdge({
      id: "edge-b",
      source: "person-a",
      target: "fact-2",
      relation_type: "semantic",
      weight: 0.5,
      created_at: 1_000,
      last_activated_at: 1_000
    });
    graph.addEdge({
      id: "edge-c",
      source: "person-b",
      target: "fact-1",
      relation_type: "causal",
      weight: 0.5,
      created_at: 1_000,
      last_activated_at: 1_000
    });
    graph.addEdge({
      id: "edge-d",
      source: "person-b",
      target: "fact-2",
      relation_type: "emotional",
      weight: 0.5,
      created_at: 1_000,
      last_activated_at: 1_000
    });

    const result = dedupePersonEntities({
      graph,
      cognitionConfig: DEFAULT_COGNITION_CONFIG
    });

    assert.equal(result.mergedEntities.length, 1);
    assert.equal(result.mergedEntities[0]?.source_id, "person-b");
    assert.equal(result.mergedEntities[0]?.target_id, "person-a");
    assert.equal(graph.getNode("person-b"), undefined);
    assert.ok(graph.getNode("person-a"));
    assert.deepEqual(graph.getNode("person-a")?.metadata.aliases, ["王哥"]);
    assert.ok(graph.getNode("person-c"));
  } finally {
    await cleanupPaths(paths);
  }
});
