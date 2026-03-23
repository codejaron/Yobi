import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { encode } from "@msgpack/msgpack";
import { CompanionPaths } from "../storage/paths.js";
import { DEFAULT_COGNITION_CONFIG, type ActivationLogEntry, type ActivationResult, type MemoryNode } from "@shared/cognition";
import { loadCognitionConfig, patchCognitionConfig } from "../cognition/config.js";
import { computeEdgeWeight, computeFanFactor } from "../cognition/activation/fan-effect.js";
import { applyLateralInhibition } from "../cognition/activation/lateral-inhibition.js";
import { applySigmoidGate } from "../cognition/activation/sigmoid-gate.js";
import { MemoryGraphStore } from "../cognition/graph/memory-graph.js";
import { spread } from "../cognition/activation/spreading-activation.js";
import { ThoughtPool } from "../cognition/thoughts/thought-bubble.js";
import { buildBubbleSummaryContext } from "../cognition/evaluation/expression-gate.js";
import { roughFilter } from "../cognition/evaluation/rough-filter.js";
import { signalToSeeds } from "../cognition/loop/signal-to-seed.js";
import { SubconsciousLoop } from "../cognition/loop/subconscious-loop.js";
import { EmotionStateManager } from "../cognition/workspace/emotion-state.js";
import { PredictionEngine } from "../cognition/activation/prediction-coding.js";
import { AttentionSchema } from "../cognition/workspace/attention-schema.js";
import { GlobalWorkspace } from "../cognition/workspace/global-workspace.js";
import { readJsonlFile, writeJsonlFileAtomic } from "../storage/fs.js";

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

function assertClose(actual: number, expected: number, epsilon = 1e-6): void {
  assert.ok(Math.abs(actual - expected) < epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
}

async function createWorkspaceManagers(
  paths: CompanionPaths,
  config = DEFAULT_COGNITION_CONFIG,
  graph = new MemoryGraphStore(paths, config.graph_maintenance)
) {
  const emotionState = new EmotionStateManager({
    paths,
    logger: { warn() {} } as never,
    getCognitionConfig: () => config,
    analyzeEmotion: async () => config.emotion.neutral_state
  });
  await emotionState.load();
  const predictionEngine = new PredictionEngine({
    paths,
    getCognitionConfig: () => config
  });
  await predictionEngine.load();
  const attentionSchema = new AttentionSchema({
    paths,
    getCognitionConfig: () => config
  });
  await attentionSchema.load();
  const globalWorkspace = new GlobalWorkspace({
    graph,
    emotionState,
    predictionEngine,
    attentionSchema,
    logger: { warn() {} } as never,
    getCognitionConfig: () => config
  });
  return {
    emotionState,
    predictionEngine,
    attentionSchema,
    globalWorkspace
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

test("MemoryGraphStore.toJSON omits heavy node fields from debug snapshots", async () => {
  const paths = await createTempPaths("yobi-cognition-graph-debug-json-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    graph.addNode(
      makeNode({
        id: "node-a",
        content: "调试节点",
        type: "fact",
        embedding: [0.1, 0.2, 0.3],
        activation_history: [1_000, 2_000, 3_000],
        activation_level: 0.75,
        base_level_activation: 0.42
      })
    );

    const snapshot = graph.toJSON();
    const nodeRecord = snapshot.nodes[0] as unknown as Record<string, unknown>;
    assert.equal(snapshot.nodes.length, 1);
    assert.equal(snapshot.nodes[0]?.id, "node-a");
    assert.equal(snapshot.nodes[0]?.activation_history_count, 3);
    assert.equal("embedding" in nodeRecord, false);
    assert.equal("activation_history" in nodeRecord, false);
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

test("MemoryGraphStore.addEdge ignores self loops", async () => {
  const paths = await createTempPaths("yobi-cognition-edge-self-loop-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    graph.addNode(
      makeNode({
        id: "a",
        content: "自己",
        type: "fact",
        embedding: [1, 0]
      })
    );

    graph.addEdge({
      id: "self-loop",
      source: "a",
      target: "a",
      relation_type: "semantic",
      weight: 1,
      created_at: 0,
      last_activated_at: 0
    });

    assert.deepEqual(graph.getNeighbors("a"), []);
    assert.deepEqual(graph.getEdgesBetween("a", "a"), []);
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

test("computeFanFactor ignores self loops and missing targets, and computeEdgeWeight multiplies temporal decay by edge.weight", async () => {
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
      weight: 0.5,
      created_at: 0,
      last_activated_at: 0
    });
    graph.addEdge({
      id: "edge-missing",
      source: "source",
      target: "missing",
      relation_type: "semantic",
      weight: 1,
      created_at: 0,
      last_activated_at: 0
    });
    graph.deserialize(
      encode({
        nodes: graph.getAllNodes(),
        edges: [
          ...graph.toJSON().edges,
          {
            id: "legacy-self-loop",
            source: "source",
            target: "source",
            relation_type: "semantic",
            weight: 1,
            created_at: 0,
            last_activated_at: 0
          }
        ]
      })
    );

    const sourceNode = graph.getNode("source");
    const targetNode = graph.getNode("target");
    assert.equal(computeFanFactor(graph, "source"), 1);
    assert.ok(sourceNode);
    assert.ok(targetNode);
    assertClose(
      computeEdgeWeight({
        sourceNode,
        targetNode,
        edge: graph.getEdgesBetween("source", "target")[0]!,
        temporalDecayRho: 0.01
      }),
      0.5 * Math.exp(-0.1)
    );
  } finally {
    await cleanupPaths(paths);
  }
});

test("applyLateralInhibition keeps winners unchanged and subtracts beta times winner sum from non-winners", () => {
  const result = applyLateralInhibition(
    new Map([
      ["a", 1],
      ["b", 0.8],
      ["c", 0.3]
    ]),
    {
      lateral_inhibition_top_M: 2,
      lateral_inhibition_beta: 0.1
    }
  );

  assert.deepEqual(
    result.winners.map((winner) => winner.node_id),
    ["a", "b"]
  );
  assert.equal(result.totals.get("a"), 1);
  assert.equal(result.totals.get("b"), 0.8);
  assertClose(result.totals.get("c") ?? 0, 0.12);
});

test("applySigmoidGate uses logistic activation and drops values below 0.001", () => {
  const result = applySigmoidGate(
    new Map([
      ["strong", 0.5],
      ["tiny", -1]
    ]),
    {
      gamma: 10,
      theta: 0.3
    }
  );

  assertClose(result.get("strong") ?? 0, 1 / (1 + Math.exp(-2)));
  assert.equal(result.has("tiny"), false);
});

test("spread applies fan effect, inhibition, sigmoid gating, and post-sigmoid trimming", async () => {
  const paths = await createTempPaths("yobi-cognition-spread-phase2-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    for (const node of [
      makeNode({ id: "source", content: "源节点", type: "concept", embedding: [1, 0, 0] }),
      makeNode({ id: "a", content: "A", type: "fact", embedding: [0, 1, 0] }),
      makeNode({ id: "b", content: "B", type: "fact", embedding: [0, 0, 1] }),
      makeNode({ id: "c", content: "C", type: "fact", embedding: [1, 1, 0] })
    ]) {
      graph.addNode(node);
    }

    graph.addEdge({
      id: "edge-a",
      source: "source",
      target: "a",
      relation_type: "semantic",
      weight: 1,
      created_at: 0,
      last_activated_at: 0
    });
    graph.addEdge({
      id: "edge-b",
      source: "source",
      target: "b",
      relation_type: "semantic",
      weight: 0.5,
      created_at: 0,
      last_activated_at: 0
    });
    graph.addEdge({
      id: "edge-c",
      source: "source",
      target: "c",
      relation_type: "semantic",
      weight: 0.25,
      created_at: 0,
      last_activated_at: 0
    });

    const result = spread(graph, [{ nodeId: "source", energy: 1 }], {
      spreading: {
        spreading_factor: 0.8,
        retention_delta: 0.5,
        temporal_decay_rho: 0.01,
        diffusion_max_depth: 1,
        spreading_size_limit: 2
      },
      inhibition: {
        lateral_inhibition_top_M: 1,
        lateral_inhibition_beta: 0.1
      },
      sigmoid: {
        gamma: 10,
        theta: 0.3
      }
    });

    const fanAdjustedA = 0.8 / 3;
    const fanAdjustedB = 0.4 / 3;
    const fanAdjustedC = 0.2 / 3;
    const inhibitedB = Math.max(0, fanAdjustedB - 0.1 * fanAdjustedA);
    const inhibitedC = Math.max(0, fanAdjustedC - 0.1 * fanAdjustedA);
    const gatedA = 1 / (1 + Math.exp(-10 * (fanAdjustedA - 0.3)));
    const gatedB = 1 / (1 + Math.exp(-10 * (inhibitedB - 0.3)));
    const gatedC = 1 / (1 + Math.exp(-10 * (inhibitedC - 0.3)));

    assert.equal(result.activated.get("source"), 0.5);
    assertClose(result.activated.get("a") ?? 0, gatedA);
    assertClose(result.activated.get("b") ?? 0, gatedB);
    assert.equal(result.activated.has("c"), false);

    const round = result.path_log[0];
    assert.ok(round);
    assertClose(round.propagation_totals?.find((item) => item.node_id === "a")?.activation ?? 0, fanAdjustedA);
    assert.deepEqual(
      round.inhibition_winners?.map((item) => item.node_id),
      ["a"]
    );
    assertClose(round.inhibited_totals?.find((item) => item.node_id === "b")?.activation ?? 0, inhibitedB);
    assertClose(round.gated_totals?.find((item) => item.node_id === "a")?.activation ?? 0, gatedA);
    assert.deepEqual(
      round.trimmed_totals?.map((item) => item.node_id),
      ["a", "b"]
    );
    assertClose(round.trimmed_totals?.find((item) => item.node_id === "b")?.activation ?? 0, gatedB);
    assert.ok((round.trimmed_totals?.find((item) => item.node_id === "c")?.activation ?? 0) === 0);
    assert.ok(gatedC < gatedB);
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

test("signalToSeeds downweights time markers so they do not dominate manual seed slots", async () => {
  const paths = await createTempPaths("yobi-cognition-seeds-type-weight-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    graph.addNode(
      makeNode({
        id: "calendar",
        content: "今天星期几",
        type: "time_marker",
        embedding: [1, 0, 0]
      })
    );
    graph.addNode(
      makeNode({
        id: "weekend",
        content: "周末安排一点外出活动",
        type: "pattern",
        embedding: [0.9, Math.sqrt(0.19), 0]
      })
    );

    const manualSeeds = await signalToSeeds(
      {
        type: "manual_signal",
        payload: {
          text: "今天周几"
        }
      },
      graph,
      async () => [1, 0, 0]
    );

    assert.equal(manualSeeds[0]?.nodeId, "weekend");
    assert.equal(manualSeeds[1]?.nodeId, "calendar");
    assert.ok((manualSeeds[0]?.energy ?? 0) > (manualSeeds[1]?.energy ?? 0));
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

test("buildBubbleSummaryContext uses node content and relation paths instead of raw ids", () => {
  const seedNode = makeNode({ id: "seed", content: "周末", type: "time_marker", embedding: [1, 0, 0] });
  const weekendNode = makeNode({
    id: "uuid-a",
    content: "周末说好出门结果在家躺两天只下楼拿快递",
    type: "fact",
    embedding: [0, 1, 0]
  });
  const moodNode = makeNode({ id: "uuid-b", content: "兴奋", type: "emotion_anchor", embedding: [0, 0, 1] });
  const graph = {
    getNode(id: string) {
      return new Map([
        [seedNode.id, seedNode],
        [weekendNode.id, weekendNode],
        [moodNode.id, moodNode]
      ]).get(id);
    },
    getEdgesBetween(source: string, target: string) {
      if (source === weekendNode.id && target === moodNode.id) {
        return [{
          id: "weekend-mood",
          source,
          target,
          relation_type: "emotional" as const,
          weight: 0.2,
          created_at: 0,
          last_activated_at: 0
        }];
      }
      return [];
    }
  };

  const context = buildBubbleSummaryContext({
    id: "bubble",
    summary: "",
    source_seeds: [seedNode.id],
    activated_nodes: [
      { node_id: weekendNode.id, activation: 0.42 },
      { node_id: moodNode.id, activation: 0.38 }
    ],
    activation_peak: 0.42,
    emotional_tone: 0.1,
    novelty_score: 1,
    created_at: 0,
    last_reinforced_at: 0,
    status: "nascent"
  }, graph);

  assert.match(context, /周末说好出门结果在家躺两天只下楼拿快递/);
  assert.match(context, /兴奋/);
  assert.match(context, /周末/);
  assert.match(context, /--emotional-->/);
  assert.doesNotMatch(context, /uuid-a|uuid-b/);
});

test("buildBubbleSummaryContext does not leak missing node ids", () => {
  const context = buildBubbleSummaryContext({
    id: "bubble",
    summary: "",
    source_seeds: ["b5dc8438-8aa5-4886-b283-9a6eab0f0b47"],
    activated_nodes: [
      { node_id: "04fb6be5-bf04-4687-9862-b197eaa2249e", activation: 0.5 }
    ],
    activation_peak: 0.5,
    emotional_tone: 0,
    novelty_score: 1,
    created_at: 0,
    last_reinforced_at: 0,
    status: "nascent"
  }, {
    getNode() {
      return undefined;
    },
    getEdgesBetween() {
      return [];
    }
  });

  assert.match(context, /未知记忆/);
  assert.doesNotMatch(context, /04fb6be5|b5dc8438/);
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
    const workspace = await createWorkspaceManagers(paths, DEFAULT_COGNITION_CONFIG, graph);

    const loop = new SubconsciousLoop({
      graph,
      thoughtPool: new ThoughtPool(paths),
      emotionState: workspace.emotionState,
      predictionEngine: workspace.predictionEngine,
      attentionSchema: workspace.attentionSchema,
      globalWorkspace: workspace.globalWorkspace,
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

test("SubconsciousLoop clears timeline and experiment logs independently", async () => {
  const paths = await createTempPaths("yobi-cognition-loop-clear-logs-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    const workspace = await createWorkspaceManagers(paths, DEFAULT_COGNITION_CONFIG, graph);

    const loop = new SubconsciousLoop({
      graph,
      thoughtPool: new ThoughtPool(paths),
      emotionState: workspace.emotionState,
      predictionEngine: workspace.predictionEngine,
      attentionSchema: workspace.attentionSchema,
      globalWorkspace: workspace.globalWorkspace,
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

    const automaticEntry: ActivationLogEntry = {
      timestamp: 1,
      trigger_type: "time_signal",
      seeds: [],
      top_activated: [],
      bubbles_generated: 0,
      bubble_passed_filter: false,
      expression_produced: false,
      expression_text: null,
      manual_text: null
    };
    const manualEntry: ActivationLogEntry = {
      timestamp: 2,
      trigger_type: "manual_signal",
      seeds: [],
      top_activated: [],
      bubbles_generated: 0,
      bubble_passed_filter: false,
      expression_produced: false,
      expression_text: null,
      manual_text: "中午吃什么"
    };
    const bufferState = loop as unknown as { recentLogsBuffer: ActivationLogEntry[] };

    await writeJsonlFileAtomic(paths.cognitionActivationLogPath, [automaticEntry, manualEntry]);
    bufferState.recentLogsBuffer = [automaticEntry, manualEntry];

    const clearedTimeline = await loop.clearActivationLogs("timeline");

    assert.deepEqual(clearedTimeline, { removed: 1, remaining: 1 });
    assert.deepEqual(await readJsonlFile(paths.cognitionActivationLogPath), [manualEntry]);
    assert.deepEqual(loop.getRecentLogs(10), [manualEntry]);

    await writeJsonlFileAtomic(paths.cognitionActivationLogPath, [automaticEntry, manualEntry]);
    bufferState.recentLogsBuffer = [automaticEntry, manualEntry];

    const clearedExperiments = await loop.clearActivationLogs("experiments");

    assert.deepEqual(clearedExperiments, { removed: 1, remaining: 1 });
    assert.deepEqual(await readJsonlFile(paths.cognitionActivationLogPath), [automaticEntry]);
    assert.deepEqual(loop.getRecentLogs(10), [automaticEntry]);
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
    const workspace = await createWorkspaceManagers(paths, config, graph);

    const loop = new SubconsciousLoop({
      graph,
      thoughtPool: new ThoughtPool(paths),
      emotionState: workspace.emotionState,
      predictionEngine: workspace.predictionEngine,
      attentionSchema: workspace.attentionSchema,
      globalWorkspace: workspace.globalWorkspace,
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

    assert.ok(entry.top_activated[0]);
    assert.equal(entry.activation_peak, entry.top_activated[0]?.activation);
  } finally {
    await cleanupPaths(paths);
  }
});

test("SubconsciousLoop hop summaries use post-gate surviving activations instead of raw propagation totals", async () => {
  const paths = await createTempPaths("yobi-cognition-loop-hop-summary-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    for (const node of [
      makeNode({ id: "seed", content: "种子", type: "concept", embedding: [1, 0, 0] }),
      makeNode({ id: "winner", content: "胜者", type: "fact", embedding: [0, 1, 0] }),
      makeNode({ id: "runner", content: "跟随者", type: "fact", embedding: [0, 0, 1] })
    ]) {
      graph.addNode(node);
    }
    graph.addEdge({
      id: "seed-winner",
      source: "seed",
      target: "winner",
      relation_type: "semantic",
      weight: 1,
      created_at: 0,
      last_activated_at: 0
    });
    graph.addEdge({
      id: "seed-runner",
      source: "seed",
      target: "runner",
      relation_type: "semantic",
      weight: 0.5,
      created_at: 0,
      last_activated_at: 0
    });

    const config = {
      ...DEFAULT_COGNITION_CONFIG,
      spreading: {
        ...DEFAULT_COGNITION_CONFIG.spreading,
        diffusion_max_depth: 1
      },
      inhibition: {
        lateral_inhibition_top_M: 1,
        lateral_inhibition_beta: 0.1
      },
      expression: {
        ...DEFAULT_COGNITION_CONFIG.expression,
        activation_threshold: 2
      }
    };
    const workspace = await createWorkspaceManagers(paths, config, graph);

    const loop = new SubconsciousLoop({
      graph,
      thoughtPool: new ThoughtPool(paths),
      emotionState: workspace.emotionState,
      predictionEngine: workspace.predictionEngine,
      attentionSchema: workspace.attentionSchema,
      globalWorkspace: workspace.globalWorkspace,
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

    const entry = await loop.triggerManualSpread("种子");

    assert.equal(entry.hop_summaries?.[0]?.nodes[0]?.node_id, "winner");
    assert.ok((entry.hop_summaries?.[0]?.nodes[0]?.activation ?? 0) > 0.4);
    assert.ok((entry.hop_summaries?.[0]?.nodes[0]?.activation ?? 0) < 1);
    assert.equal(entry.path_log?.[0]?.propagation_totals?.[0]?.node_id, "winner");
    assert.ok((entry.path_log?.[0]?.propagation_totals?.[0]?.activation ?? 0) < (entry.hop_summaries?.[0]?.nodes[0]?.activation ?? 0));
  } finally {
    await cleanupPaths(paths);
  }
});
