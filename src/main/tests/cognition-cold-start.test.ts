import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { DEFAULT_COGNITION_CONFIG } from "@shared/cognition";
import { CompanionPaths } from "../storage/paths.js";
import { MemoryGraphStore } from "../cognition/graph/memory-graph.js";
import {
  runColdStart
} from "../cognition/ingestion/cold-start.js";
import { FIXED_USER_PERSON_ID, FIXED_YOBI_PERSON_ID } from "../cognition/ingestion/graph-adapter.js";

async function createTempPaths(prefix: string): Promise<CompanionPaths> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const paths = new CompanionPaths(baseDir);
  paths.ensureLayout();
  return paths;
}

async function cleanupPaths(paths: CompanionPaths): Promise<void> {
  await fs.rm(paths.baseDir, { recursive: true, force: true });
}

test("runColdStart seeds an empty graph once and adds fixed person nodes plus derived edges", async () => {
  const paths = await createTempPaths("yobi-cognition-cold-start-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    const embeddings = new Map<string, number[]>([
      ["Yobi比较安静但会在意朋友的状态", [1, 0, 0]],
      ["Yobi喜欢轻松自然的陪伴感", [0.95, 0.05, 0]],
      ["开心", [0, 1, 0]],
      ["早上", [0, 0, 1]],
      ["深夜", [0, 0, 0.95]],
      ["用户", [0.5, 0.5, 0]],
      ["Yobi", [0.4, 0.6, 0]]
    ]);
    let generatedCount = 0;

    const first = await runColdStart({
      paths,
      graph,
      nowMs: 1_000,
      cognitionConfig: DEFAULT_COGNITION_CONFIG,
      soulMarkdown: "# Soul\n- test\n",
      embedText: async (text) => embeddings.get(text) ?? [0.1, 0.1, 0.1],
      generateSeeds: async () => {
        generatedCount += 1;
        return {
          nodes: [
            { content: "Yobi比较安静但会在意朋友的状态", type: "concept", emotional_valence: 0.3 },
            { content: "Yobi喜欢轻松自然的陪伴感", type: "concept", emotional_valence: 0.2 },
            { content: "开心", type: "emotion_anchor", emotional_valence: 0.9 },
            { content: "早上", type: "time_marker", emotional_valence: 0 },
            { content: "深夜", type: "time_marker", emotional_valence: -0.1 }
          ],
          edges: []
        };
      }
    });

    assert.equal(first.created, true);
    assert.equal(generatedCount, 1);
    assert.ok(graph.getNode(FIXED_USER_PERSON_ID));
    assert.ok(graph.getNode(FIXED_YOBI_PERSON_ID));
    assert.ok(graph.getAllEdges().some((edge) => edge.relation_type === "semantic"));
    assert.ok(graph.getAllEdges().some((edge) => edge.relation_type === "temporal"));
    assert.ok(graph.getAllEdges().some((edge) => edge.relation_type === "emotional"));

    const second = await runColdStart({
      paths,
      graph,
      nowMs: 2_000,
      cognitionConfig: DEFAULT_COGNITION_CONFIG,
      soulMarkdown: "# Soul\n- ignored\n",
      embedText: async (text) => embeddings.get(text) ?? [0.1, 0.1, 0.1],
      generateSeeds: async () => {
        generatedCount += 1;
        return {
          nodes: [],
          edges: []
        };
      }
    });

    assert.equal(second.created, false);
    assert.equal(generatedCount, 1);
  } finally {
    await cleanupPaths(paths);
  }
});
