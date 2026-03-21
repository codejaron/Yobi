import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { CompanionPaths } from "../storage/paths.js";
import { DEFAULT_COGNITION_CONFIG, type ActivationResult, type MemoryNode } from "@shared/cognition";
import { loadCognitionConfig, patchCognitionConfig } from "../cognition/config.js";
import { MemoryGraphStore } from "../cognition/graph/memory-graph.js";
import { spread } from "../cognition/activation/spreading-activation.js";
import { ThoughtPool } from "../cognition/thoughts/thought-bubble.js";
import { roughFilter } from "../cognition/evaluation/rough-filter.js";
import { signalToSeeds } from "../cognition/loop/signal-to-seed.js";
import { SubconsciousLoop } from "../cognition/loop/subconscious-loop.js";

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

function makeActivationResult(entries: Array<[string, number]>): ActivationResult {
  return {
    activated: new Map(entries),
    path_log: []
  };
}

test("loadCognitionConfig bootstraps the default cognition config file", async () => {
  const paths = await createTempPaths("yobi-cognition-config-");
  try {
    const loaded = await loadCognitionConfig(paths);

    assert.deepEqual(loaded, DEFAULT_COGNITION_CONFIG);

    const raw = JSON.parse(await fs.readFile(paths.cognitionConfigPath, "utf8"));
    assert.deepEqual(raw, DEFAULT_COGNITION_CONFIG);
  } finally {
    await cleanupPaths(paths);
  }
});

test("patchCognitionConfig deep merges partial updates and persists them", async () => {
  const paths = await createTempPaths("yobi-cognition-config-patch-");
  try {
    const loaded = await loadCognitionConfig(paths);
    const patched = await patchCognitionConfig(paths, loaded, {
      spreading: {
        spreading_factor: 0.3
      },
      expression: {
        cooldown_minutes: 45
      },
      loop: {
        heartbeat_lambda_minutes: 9
      }
    });

    assert.equal(patched.spreading.spreading_factor, 0.3);
    assert.equal(patched.spreading.retention_delta, DEFAULT_COGNITION_CONFIG.spreading.retention_delta);
    assert.equal(patched.expression.cooldown_minutes, 45);
    assert.equal(patched.loop.heartbeat_lambda_minutes, 9);

    const raw = JSON.parse(await fs.readFile(paths.cognitionConfigPath, "utf8"));
    assert.equal(raw.spreading.spreading_factor, 0.3);
    assert.equal(raw.expression.cooldown_minutes, 45);
    assert.equal(raw.loop.heartbeat_lambda_minutes, 9);
  } finally {
    await cleanupPaths(paths);
  }
});

test("MemoryGraphStore.addNode merges duplicate embeddings above threshold", async () => {
  const paths = await createTempPaths("yobi-cognition-graph-merge-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    graph.addNode(
      makeNode({
        id: "node-a",
        content: "午餐偏好",
        type: "fact",
        embedding: [1, 0, 0],
        activation_history: [1_000],
        created_at: 1_000
      })
    );
    graph.addNode(
      makeNode({
        id: "node-b",
        content: "用户中午常纠结吃什么",
        type: "fact",
        embedding: [1, 0, 0],
        activation_history: [2_000],
        created_at: 2_000
      })
    );

    const nodes = graph.getAllNodes();
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0]?.content, "用户中午常纠结吃什么");
    assert.deepEqual(nodes[0]?.activation_history, [1_000, 2_000]);
  } finally {
    await cleanupPaths(paths);
  }
});

test("MemoryGraphStore.addNode does not merge embeddings when dimensions differ", async () => {
  const paths = await createTempPaths("yobi-cognition-graph-dimension-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    graph.addNode(
      makeNode({
        id: "node-a",
        content: "维度 2",
        type: "fact",
        embedding: [1, 0]
      })
    );
    graph.addNode(
      makeNode({
        id: "node-b",
        content: "维度 3",
        type: "fact",
        embedding: [1, 0, 0]
      })
    );

    assert.deepEqual(
      graph.getAllNodes().map((node) => node.id).sort(),
      ["node-a", "node-b"]
    );
  } finally {
    await cleanupPaths(paths);
  }
});

test("MemoryGraphStore.replaceNode updates an existing node in place", async () => {
  const paths = await createTempPaths("yobi-cognition-graph-replace-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    graph.addNode(
      makeNode({
        id: "node-a",
        content: "旧内容",
        type: "fact",
        embedding: [1, 0]
      })
    );

    const replaced = graph.replaceNode(
      makeNode({
        id: "node-a",
        content: "新内容",
        type: "fact",
        embedding: [0, 1],
        metadata: {
          repaired: true
        }
      })
    );

    assert.equal(replaced?.content, "新内容");
    assert.deepEqual(replaced?.embedding, [0, 1]);
    assert.deepEqual(graph.getNode("node-a")?.metadata, { repaired: true });
  } finally {
    await cleanupPaths(paths);
  }
});

test("MemoryGraphStore.addEdge caps outgoing edges per source by evicting the weakest edge", async () => {
  const paths = await createTempPaths("yobi-cognition-edge-cap-");
  try {
    const graph = new MemoryGraphStore(paths, {
      ...DEFAULT_COGNITION_CONFIG.graph_maintenance,
      max_edges_per_node: 2
    });
    for (const id of ["a", "b", "c", "d"]) {
      graph.addNode(
        makeNode({
          id,
          content: id,
          type: "fact",
          embedding: [id.charCodeAt(0), 0]
        })
      );
    }

    graph.addEdge({
      id: "edge-1",
      source: "a",
      target: "b",
      relation_type: "semantic",
      weight: 0.9,
      created_at: 1_000,
      last_activated_at: 1_000
    });
    graph.addEdge({
      id: "edge-2",
      source: "a",
      target: "c",
      relation_type: "semantic",
      weight: 0.2,
      created_at: 1_000,
      last_activated_at: 1_000
    });
    graph.addEdge({
      id: "edge-3",
      source: "a",
      target: "d",
      relation_type: "semantic",
      weight: 0.5,
      created_at: 1_000,
      last_activated_at: 1_000
    });

    const neighbors = graph.getNeighbors("a");
    assert.deepEqual(
      neighbors.map((item) => item.target).sort(),
      ["b", "d"]
    );
  } finally {
    await cleanupPaths(paths);
  }
});

test("MemoryGraphStore.computeBaseLevelActivation applies ACT-R decay in seconds", async () => {
  const paths = await createTempPaths("yobi-cognition-actr-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    graph.addNode(
      makeNode({
        id: "seed",
        content: "中午",
        type: "time_marker",
        embedding: [0, 1, 0],
        activation_history: [1_000, 4_000]
      })
    );

    const value = graph.computeBaseLevelActivation("seed", 5_000);
    const expected = Math.log(1 + Math.pow(4, -0.5));

    assert.ok(Math.abs(value - expected) < 1e-6);
  } finally {
    await cleanupPaths(paths);
  }
});

test("spread applies temporal decay to temporal edges and retains source activation", async () => {
  const paths = await createTempPaths("yobi-cognition-spread-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    graph.addNode(
      makeNode({
        id: "source",
        content: "午餐",
        type: "concept",
        embedding: [1, 0],
        created_at: 0
      })
    );
    graph.addNode(
      makeNode({
        id: "target",
        content: "周末",
        type: "event",
        embedding: [0, 1],
        created_at: 10 * 24 * 60 * 60 * 1000
      })
    );
    graph.addEdge({
      id: "edge-temporal",
      source: "source",
      target: "target",
      relation_type: "temporal",
      weight: 1,
      created_at: 0,
      last_activated_at: 0
    });

    const result = spread(
      graph,
      [{ nodeId: "source", energy: 1 }],
      {
        spreading_factor: 0.8,
        retention_delta: 0.5,
        temporal_decay_rho: 0.01,
        diffusion_max_depth: 1,
        spreading_size_limit: 300
      }
    );

    const expectedTarget = 0.8 * Math.exp(-0.1);
    assert.ok(Math.abs((result.activated.get("target") ?? 0) - expectedTarget) < 1e-6);
    assert.equal(result.activated.get("source"), 0.5);
    assert.equal(result.path_log.length, 1);
  } finally {
    await cleanupPaths(paths);
  }
});

test("signalToSeeds matches time markers and keeps only manual cosine matches above threshold", async () => {
  const paths = await createTempPaths("yobi-cognition-seeds-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    graph.addNode(
      makeNode({
        id: "time-noon",
        content: "中午午餐提醒",
        type: "time_marker",
        embedding: [0, 0, 1]
      })
    );
    graph.addNode(
      makeNode({
        id: "time-thursday",
        content: "星期四固定外出",
        type: "time_marker",
        embedding: [0, 1, 0]
      })
    );
    graph.addNode(
      makeNode({
        id: "lunch",
        content: "中午吃什么",
        type: "concept",
        embedding: [1, 0, 0]
      })
    );
    graph.addNode(
      makeNode({
        id: "weekend",
        content: "周末计划",
        type: "event",
        embedding: [0.6, 0.8, 0]
      })
    );

    const timeSeeds = await signalToSeeds(
      {
        type: "time_signal",
        payload: {
          hour: 12,
          weekday: "Thursday",
          date: "2026-03-21"
        }
      },
      graph,
      async () => null
    );
    assert.deepEqual(
      timeSeeds.map((seed) => seed.nodeId).sort(),
      ["time-noon", "time-thursday"]
    );

    const manualSeeds = await signalToSeeds(
      {
        type: "manual_signal",
        payload: {
          text: "中午吃什么"
        }
      },
      graph,
      async () => [1, 0, 0]
    );
    assert.deepEqual(
      manualSeeds.map((seed) => seed.nodeId),
      ["lunch", "weekend"]
    );
    assert.equal(manualSeeds[0]?.energy, 1);
    assert.ok((manualSeeds[1]?.energy ?? 0) > 0);
  } finally {
    await cleanupPaths(paths);
  }
});

test("signalToSeeds returns no manual seeds when all semantic matches fall below threshold", async () => {
  const paths = await createTempPaths("yobi-cognition-seeds-threshold-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    graph.addNode(
      makeNode({
        id: "lunch",
        content: "中午吃什么",
        type: "concept",
        embedding: [1, 0, 0]
      })
    );
    graph.addNode(
      makeNode({
        id: "weekend",
        content: "周末计划",
        type: "event",
        embedding: [0, 1, 0]
      })
    );

    const manualSeeds = await signalToSeeds(
      {
        type: "manual_signal",
        payload: {
          text: "完全无关的话题"
        }
      },
      graph,
      async () => [0, 0, 1]
    );

    assert.deepEqual(manualSeeds, []);
  } finally {
    await cleanupPaths(paths);
  }
});

test("signalToSeeds rejects manual candidates below the 0.55 semantic threshold", async () => {
  const paths = await createTempPaths("yobi-cognition-seeds-min-threshold-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    graph.addNode(
      makeNode({
        id: "half-match",
        content: "半相关话题",
        type: "concept",
        embedding: [1, Math.sqrt(3), 0]
      })
    );

    const manualSeeds = await signalToSeeds(
      {
        type: "manual_signal",
        payload: {
          text: "查询"
        }
      },
      graph,
      async () => [1, 0, 0]
    );

    assert.deepEqual(manualSeeds, []);
  } finally {
    await cleanupPaths(paths);
  }
});

test("signalToSeeds ignores manual candidates whose embedding dimensions do not match the query", async () => {
  const paths = await createTempPaths("yobi-cognition-seeds-dimension-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    graph.addNode(
      makeNode({
        id: "mismatch",
        content: "示例节点",
        type: "concept",
        embedding: [1, 0]
      })
    );
    graph.addNode(
      makeNode({
        id: "valid",
        content: "真正相近的话题",
        type: "fact",
        embedding: [1, 0, 0]
      })
    );

    const manualSeeds = await signalToSeeds(
      {
        type: "manual_signal",
        payload: {
          text: "真正相近的话题"
        }
      },
      graph,
      async () => [1, 0, 0]
    );

    assert.deepEqual(
      manualSeeds.map((seed) => seed.nodeId),
      ["valid"]
    );
  } finally {
    await cleanupPaths(paths);
  }
});

test("ThoughtPool enforces capacity and decays weak bubbles out of the active pool", async () => {
  const paths = await createTempPaths("yobi-cognition-thoughts-");
  try {
    const pool = new ThoughtPool(paths);

    for (let index = 0; index < 6; index += 1) {
      pool.createBubble(
        [`seed-${index}`],
        [
          { nodeId: `seed-${index}`, activation: 0.1 * (index + 1) }
        ],
        makeActivationResult([[`seed-${index}`, 0.1 * (index + 1)]])
      );
    }

    assert.equal(pool.getBubbles().length, 5);
    assert.ok(pool.getBubbles().every((bubble) => bubble.activation_peak >= 0.2));

    pool.decayAll(0.01);

    assert.equal(pool.getBubbles().length, 0);
  } finally {
    await cleanupPaths(paths);
  }
});

test("roughFilter only passes when all four phase-one conditions are satisfied", () => {
  const bubble = {
    id: "bubble",
    summary: "",
    source_seeds: ["seed"],
    activated_nodes: [{ node_id: "seed", activation: 0.6 }],
    activation_peak: 0.6,
    emotional_tone: 0,
    novelty_score: 1,
    created_at: Date.now(),
    last_reinforced_at: Date.now(),
    status: "nascent" as const
  };
  const config = DEFAULT_COGNITION_CONFIG;
  const now = Date.now();

  assert.equal(
    roughFilter(bubble, now - 31 * 60 * 1000, true, config),
    true
  );
  assert.equal(
    roughFilter({ ...bubble, activation_peak: 0.39 }, now - 31 * 60 * 1000, true, config),
    false
  );
  assert.equal(
    roughFilter({ ...bubble, novelty_score: 0 }, now - 31 * 60 * 1000, true, config),
    false
  );
  assert.equal(
    roughFilter(bubble, now - 5 * 60 * 1000, true, config),
    false
  );
  assert.equal(
    roughFilter(bubble, now - 31 * 60 * 1000, false, config),
    false
  );
});

test("SubconsciousLoop clears stale activation when a manual run produces no seeds", async () => {
  const paths = await createTempPaths("yobi-cognition-loop-no-seeds-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    graph.addNode(
      makeNode({
        id: "lunch",
        content: "中午吃什么",
        type: "concept",
        embedding: [0, 1, 0],
        activation_level: 0.42
      })
    );

    const loop = new SubconsciousLoop({
      graph,
      thoughtPool: new ThoughtPool(paths),
      memory: {
        embedText: async () => [1, 0, 0],
        getProfile: async () => ({}) as never,
        listHistoryByCursor: async () => ({ items: [] }) as never
      },
      modelFactory: {} as never,
      logger: {
        info() {},
        warn() {},
        error() {}
      } as never,
      paths: {
        cognitionActivationLogPath: paths.cognitionActivationLogPath
      },
      getAppConfig: () => ({}) as never,
      getCognitionConfig: () => DEFAULT_COGNITION_CONFIG,
      getUserOnline: () => true,
      getLastExpressionTime: () => 0,
      setLastExpressionTime: () => {},
      onProactiveMessage: async () => {},
      onTickCompleted: async () => {}
    });

    const entry = await loop.triggerManualSpread("完全无关的话题");

    assert.deepEqual(entry.seeds, []);
    assert.equal(graph.getNode("lunch")?.activation_level, 0);
  } finally {
    await cleanupPaths(paths);
  }
});

test("SubconsciousLoop logs a fresh bubble peak without decaying it in the same tick", async () => {
  const paths = await createTempPaths("yobi-cognition-loop-peak-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    graph.addNode(
      makeNode({
        id: "seed",
        content: "中午吃什么",
        type: "concept",
        embedding: [1, 0, 0]
      })
    );
    graph.addNode(
      makeNode({
        id: "target",
        content: "最近更想吃汤面",
        type: "fact",
        embedding: [0, 1, 0]
      })
    );
    graph.addEdge({
      id: "seed-target",
      source: "seed",
      target: "target",
      relation_type: "semantic",
      weight: 1,
      created_at: Date.now(),
      last_activated_at: Date.now()
    });

    const config = {
      ...DEFAULT_COGNITION_CONFIG,
      expression: {
        ...DEFAULT_COGNITION_CONFIG.expression,
        activation_threshold: 2
      }
    };

    const loop = new SubconsciousLoop({
      graph,
      thoughtPool: new ThoughtPool(paths),
      memory: {
        embedText: async () => [1, 0, 0],
        getProfile: async () => ({}) as never,
        listHistoryByCursor: async () => ({ items: [] }) as never
      },
      modelFactory: {} as never,
      logger: {
        info() {},
        warn() {},
        error() {}
      } as never,
      paths: {
        cognitionActivationLogPath: paths.cognitionActivationLogPath
      },
      getAppConfig: () => ({}) as never,
      getCognitionConfig: () => config,
      getUserOnline: () => true,
      getLastExpressionTime: () => 0,
      setLastExpressionTime: () => {},
      onProactiveMessage: async () => {},
      onTickCompleted: async () => {}
    });

    const entry = await loop.triggerManualSpread("中午吃什么");

    assert.equal(entry.top_activated[0]?.node_id, "seed");
    assert.equal(entry.top_activated[0]?.activation, 0.5);
    assert.equal(entry.activation_peak, entry.top_activated[0]?.activation);
  } finally {
    await cleanupPaths(paths);
  }
});
