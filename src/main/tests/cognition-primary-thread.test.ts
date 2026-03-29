import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "@shared/types";
import { DEFAULT_COGNITION_CONFIG, type MemoryNode } from "@shared/cognition";
import { PRIMARY_RESOURCE_ID, PRIMARY_THREAD_ID } from "@shared/runtime-ids";
import { CompanionPaths } from "../storage/paths.js";
import { MemoryGraphStore } from "../cognition/graph/memory-graph.js";
import { CognitionEngine } from "../cognition/engine.js";

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

test("CognitionEngine.buildReplyMemoryBlock uses primary runtime ids for recent-dialogue dedup", async () => {
  const paths = await createTempPaths("yobi-cognition-primary-thread-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    graph.addNode(
      makeNode({
        id: "ramen",
        content: "用户喜欢热乎的拉面",
        type: "fact",
        embedding: [1, 0, 0]
      })
    );

    let seenInput:
      | {
          resourceId: string;
          threadId: string;
          limit?: number;
        }
      | null = null;

    const engine = new CognitionEngine({
      paths,
      getConfig: () => DEFAULT_CONFIG,
      memory: {
        embedText: async (text: string) => {
          if (
            text === "认知图 embedding probe" ||
            text === "拉面" ||
            text === "最近一直在吃拉面" ||
            text === "用户喜欢热乎的拉面"
          ) {
            return [1, 0, 0];
          }
          return [0, 0, 1];
        },
        listHistoryByCursor: async (input: { resourceId: string; threadId: string; limit?: number }) => {
          seenInput = input;
          return {
            items: [
              {
                text: "最近一直在吃拉面"
              }
            ],
            hasMore: false,
            nextCursor: null
          };
        }
      } as any,
      conversation: {} as any,
      logger: {
        info() {},
        warn() {},
        error() {}
      } as any
    });

    (engine as any).initialized = true;
    (engine as any).graph = graph;
    (engine as any).cognitionConfig = DEFAULT_COGNITION_CONFIG;

    await engine.buildReplyMemoryBlock("拉面");

    assert.deepEqual(seenInput, {
      resourceId: PRIMARY_RESOURCE_ID,
      threadId: PRIMARY_THREAD_ID,
      limit: DEFAULT_COGNITION_CONFIG.retrieval.dedup_lookback_turns * 2
    });
  } finally {
    await cleanupPaths(paths);
  }
});
