import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { CompanionPaths } from "../storage/paths.js";
import {
  DEFAULT_COGNITION_CONFIG,
  type CognitionConfig,
  type MemoryNode
} from "@shared/cognition";
import { loadCognitionConfig, patchCognitionConfig } from "../cognition/config.js";
import { MemoryGraphStore } from "../cognition/graph/memory-graph.js";
import { signalToSeeds } from "../cognition/loop/signal-to-seed.js";
import { selectTriggers } from "../cognition/loop/trigger-sources.js";
import { applyHebbianLearning } from "../cognition/graph/hebbian-learning.js";
import { applyGlobalEdgeDecay } from "../cognition/graph/edge-decay.js";
import { PoissonHeartbeat } from "../cognition/loop/heartbeat.js";
import { ThoughtPool } from "../cognition/thoughts/thought-bubble.js";
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
    base_level_activation: input.base_level_activation ?? Number.NEGATIVE_INFINITY,
    emotional_valence: input.emotional_valence ?? 0,
    created_at: now,
    last_activated_at: input.last_activated_at ?? now,
    metadata: input.metadata ?? {}
  };
}

function assertClose(actual: number, expected: number, epsilon = 1e-6): void {
  assert.ok(Math.abs(actual - expected) < epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
}

test("phase-three cognition config bootstraps new defaults and deep-merges patches", async () => {
  const paths = await createTempPaths("yobi-cognition-phase3-config-");
  try {
    const loaded = await loadCognitionConfig(paths);
    assert.equal(loaded.actr.base_level_scale, 0.1);
    assert.equal(loaded.hebbian.decay_lambda, 0.01);
    assert.equal(loaded.hebbian.passive_decay_rate, 0.001);
    assert.equal(loaded.loop.min_interval_minutes, 3);
    assert.equal(loaded.loop.max_interval_minutes, 60);
    assert.equal(loaded.loop.enabled, true);
    assert.equal(loaded.triggers.random_walk_probability, 0.2);
    assert.equal(loaded.inhibition.lateral_inhibition_top_M, 3);
    assert.equal(loaded.spreading.spreading_size_limit, 50);

    const patched = await patchCognitionConfig(paths, loaded, {
      hebbian: {
        passive_decay_rate: 0.005
      },
      triggers: {
        random_walk_probability: 0.35
      },
      loop: {
        enabled: false
      }
    });
    assert.equal(patched.hebbian.passive_decay_rate, 0.005);
    assert.equal(patched.triggers.random_walk_probability, 0.35);
    assert.equal(patched.loop.enabled, false);
    assert.equal(patched.loop.max_interval_minutes, DEFAULT_COGNITION_CONFIG.loop.max_interval_minutes);
  } finally {
    await cleanupPaths(paths);
  }
});

test("MemoryGraphStore.getTopByBaseLevel recomputes only filtered candidates and honors minHistoryLength", async () => {
  const paths = await createTempPaths("yobi-cognition-phase3-base-level-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    graph.addNode(
      makeNode({
        id: "rich",
        content: "历史丰富",
        type: "fact",
        embedding: [1, 0, 0],
        activation_history: [1_000, 4_000, 8_000]
      })
    );
    graph.addNode(
      makeNode({
        id: "short",
        content: "历史很短",
        type: "fact",
        embedding: [0, 1, 0],
        activation_history: [9_000]
      })
    );
    graph.addNode(
      makeNode({
        id: "none",
        content: "没有历史",
        type: "fact",
        embedding: [0, 0, 1],
        activation_history: []
      })
    );

    const top = graph.getTopByBaseLevel({
      limit: 3,
      nowMs: 10_000,
      decayD: 0.5,
      candidateIds: ["rich", "short", "none"],
      minHistoryLength: 2
    });

    assert.deepEqual(top.map((node) => node.id), ["rich"]);
    assert.ok(Number.isFinite(graph.getNode("rich")?.base_level_activation ?? Number.NaN));
    assert.equal(graph.getNode("short")?.base_level_activation, Number.NEGATIVE_INFINITY);
  } finally {
    await cleanupPaths(paths);
  }
});

test("signalToSeeds supports dialogue residue, silence, rescue, and base-level seed bonus", async () => {
  const paths = await createTempPaths("yobi-cognition-phase3-seeds-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    graph.addNode(
      makeNode({
        id: "dialogue",
        content: "最近聊过午餐",
        type: "fact",
        embedding: [1, 0, 0],
        activation_history: [1_000, 4_000, 8_000]
      })
    );
    graph.addNode(
      makeNode({
        id: "silent",
        content: "沉默时容易想起的旧记忆",
        type: "event",
        embedding: [0, 1, 0],
        activation_history: [1_000, 2_000, 3_000],
        activation_level: 0.02
      })
    );
    graph.addNode(
      makeNode({
        id: "rescue",
        content: "冷图救援节点",
        type: "concept",
        embedding: [0, 0, 1],
        activation_history: [1_000, 2_000, 4_000, 8_000],
        activation_level: 0.01
      })
    );

    const dialogueSeeds = await signalToSeeds(
      {
        type: "dialogue_residue",
        payload: {
          text: "午餐"
        }
      },
      graph,
      async () => [1, 0, 0],
      {
        actr: DEFAULT_COGNITION_CONFIG.actr,
        nowMs: 10_000
      }
    );
    assert.ok(dialogueSeeds.some((seed) => seed.nodeId === "dialogue"));
    assert.ok(
      (dialogueSeeds.find((seed) => seed.nodeId === "dialogue")?.energy ?? 0) > 0.8
    );

    const silenceSeeds = await signalToSeeds(
      {
        type: "silence",
        payload: {
          duration_minutes: 60
        }
      },
      graph,
      async () => null,
      {
        actr: DEFAULT_COGNITION_CONFIG.actr,
        nowMs: 10_000
      }
    );
    assert.equal(silenceSeeds[0]?.nodeId, "rescue");
    assert.ok((silenceSeeds[0]?.energy ?? 0) > 0.6);

    const rescueSeeds = await signalToSeeds(
      {
        type: "low_activation_rescue",
        payload: {
          node_ids: ["short", "rescue", "dialogue"]
        }
      },
      graph,
      async () => null,
      {
        actr: DEFAULT_COGNITION_CONFIG.actr,
        nowMs: 10_000
      }
    );
    assert.deepEqual(
      rescueSeeds.map((seed) => seed.nodeId),
      ["rescue", "dialogue"]
    );
    assert.ok((rescueSeeds[0]?.energy ?? 0) > 1);
  } finally {
    await cleanupPaths(paths);
  }
});

test("selectTriggers prioritizes dialogue residue and appends random walk plus low-activation rescue", async () => {
  const paths = await createTempPaths("yobi-cognition-phase3-triggers-");
  const originalRandom = Math.random;
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    graph.addNode(
      makeNode({
        id: "seed-a",
        content: "午餐记忆",
        type: "fact",
        embedding: [1, 0],
        activation_history: [1_000, 2_000, 4_000],
        activation_level: 0.01
      })
    );
    graph.addNode(
      makeNode({
        id: "seed-b",
        content: "周末记忆",
        type: "event",
        embedding: [0, 1],
        activation_history: [1_000, 2_000, 3_000, 5_000],
        activation_level: 0.02
      })
    );
    Math.random = () => 0;

    const triggers = selectTriggers(
      graph,
      ["用户说想吃热的\n助手回应推荐汤面"],
      Date.now(),
      {
        online: true,
        last_active: Date.now() - 60 * 60 * 1000
      },
      DEFAULT_COGNITION_CONFIG.triggers
    );

    assert.deepEqual(
      triggers.map((trigger) => trigger.type),
      ["dialogue_residue", "random_walk", "low_activation_rescue"]
    );
  } finally {
    Math.random = originalRandom;
    await cleanupPaths(paths);
  }
});

test("applyHebbianLearning strengthens active edges and normalizes affected outgoing weights", async () => {
  const paths = await createTempPaths("yobi-cognition-phase3-hebbian-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    for (const node of [
      makeNode({ id: "source", content: "源", type: "fact", embedding: [1, 0, 0] }),
      makeNode({ id: "a", content: "A", type: "fact", embedding: [0, 1, 0] }),
      makeNode({ id: "b", content: "B", type: "fact", embedding: [0, 0, 1] })
    ]) {
      graph.addNode(node);
    }
    graph.addEdge({
      id: "source-a",
      source: "source",
      target: "a",
      relation_type: "semantic",
      weight: 0.8,
      created_at: 0,
      last_activated_at: 0
    });
    graph.addEdge({
      id: "source-b",
      source: "source",
      target: "b",
      relation_type: "semantic",
      weight: 0.7,
      created_at: 0,
      last_activated_at: 0
    });

    const log = applyHebbianLearning(
      graph,
      new Map([
        ["source", 1],
        ["a", 1],
        ["b", 0.8]
      ]),
      {
        learning_rate: 0.1,
        decay_lambda: 0.01,
        normalization_cap: 1,
        weight_min: 0.01,
        weight_max: 1
      }
    );

    const outWeights = graph.getOutgoingEdges("source").reduce((sum, edge) => sum + edge.weight, 0);
    assert.equal(log.edges_updated, 2);
    assert.equal(log.edges_strengthened, 2);
    assert.equal(log.normalization_triggered_nodes, 1);
    assert.ok(outWeights <= 1.000001);
    assert.ok((log.top_strengthened[0]?.delta ?? 0) > 0);
  } finally {
    await cleanupPaths(paths);
  }
});

test("applyGlobalEdgeDecay decays every edge and respects the minimum weight", async () => {
  const paths = await createTempPaths("yobi-cognition-phase3-edge-decay-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    for (const node of [
      makeNode({ id: "a", content: "A", type: "fact", embedding: [1, 0] }),
      makeNode({ id: "b", content: "B", type: "fact", embedding: [0, 1] }),
      makeNode({ id: "c", content: "C", type: "fact", embedding: [1, 1] })
    ]) {
      graph.addNode(node);
    }
    graph.addEdge({
      id: "a-b",
      source: "a",
      target: "b",
      relation_type: "semantic",
      weight: 1,
      created_at: 0,
      last_activated_at: 0
    });
    graph.addEdge({
      id: "a-c",
      source: "a",
      target: "c",
      relation_type: "semantic",
      weight: 0.01,
      created_at: 0,
      last_activated_at: 0
    });

    const log = applyGlobalEdgeDecay(graph, {
      passive_decay_rate: 0.1,
      weight_min: 0.01
    });

    assert.equal(log.edges_decayed, 1);
    assert.equal(log.edges_at_minimum, 1);
    assertClose(graph.getEdgeById("a-b")?.weight ?? 0, 0.9);
    assertClose(graph.getEdgeById("a-c")?.weight ?? 0, 0.01);
  } finally {
    await cleanupPaths(paths);
  }
});

test("PoissonHeartbeat honors disabled flag, clamps intervals, and defers outside active hours", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalRandom = Math.random;
  const scheduled: number[] = [];
  let timerId = 0;

  globalThis.setTimeout = ((handler: (...args: any[]) => void, delay?: number) => {
    void handler;
    scheduled.push(delay ?? 0);
    timerId += 1;
    return {
      id: timerId,
      unref() {}
    } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;

  try {
    const disabled = new PoissonHeartbeat(
      {
        heartbeat_lambda_minutes: 15,
        min_interval_minutes: 3,
        max_interval_minutes: 60,
        active_hours: { start: 7, end: 23 },
        enabled: false
      },
      async () => {}
    );
    disabled.start();
    assert.equal(scheduled.length, 0);

    const nowHour = new Date().getHours();
    const excludedWindow =
      nowHour >= 2
        ? { start: 0, end: 1 }
        : { start: 2, end: 3 };
    const deferred = new PoissonHeartbeat(
      {
        heartbeat_lambda_minutes: 15,
        min_interval_minutes: 3,
        max_interval_minutes: 60,
        active_hours: excludedWindow,
        enabled: true
      },
      async () => {}
    );
    Math.random = () => 0;
    deferred.start();
    assert.ok(scheduled[0]! > 60_000);

    scheduled.length = 0;
    const currentHour = new Date().getHours();
    const insideWindow = {
      start: currentHour,
      end: Math.min(24, currentHour + 1)
    };
    const clamped = new PoissonHeartbeat(
      {
        heartbeat_lambda_minutes: 15,
        min_interval_minutes: 3,
        max_interval_minutes: 60,
        active_hours: insideWindow.start < insideWindow.end ? insideWindow : { start: 0, end: 24 },
        enabled: true
      },
      async () => {}
    );
    Math.random = () => 0;
    clamped.start();
    assert.equal(scheduled[0], 3 * 60 * 1000);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    Math.random = originalRandom;
  }
});

test("SubconsciousLoop applies passive edge decay and reports health metrics even when no seeds are found", async () => {
  const paths = await createTempPaths("yobi-cognition-phase3-loop-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    for (const node of [
      makeNode({ id: "a", content: "A", type: "fact", embedding: [0, 1, 0], activation_level: 0.4 }),
      makeNode({ id: "b", content: "B", type: "fact", embedding: [0, 0, 1], activation_level: 0.2 })
    ]) {
      graph.addNode(node);
    }
    graph.addEdge({
      id: "a-b",
      source: "a",
      target: "b",
      relation_type: "semantic",
      weight: 1,
      created_at: 0,
      last_activated_at: 0
    });

    const logs: any[] = [];
    const config: CognitionConfig = {
      ...DEFAULT_COGNITION_CONFIG,
      hebbian: {
        ...DEFAULT_COGNITION_CONFIG.hebbian,
        passive_decay_rate: 0.1
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
      getUserActivityState: () => ({
        online: true,
        last_active: Date.now() - 60 * 60 * 1000
      }),
      getLastExpressionTime: () => 0,
      setLastExpressionTime: () => {},
      getRecentDialogueResidue: () => [],
      getLastDialogueTime: () => null,
      onProactiveMessage: async () => {},
      onTickCompleted: async (entry) => {
        logs.push(entry);
      }
    });

    const entry = await loop.triggerManualSpread("完全无关的话题");

    assert.deepEqual(entry.seeds, []);
    assert.equal(entry.edge_decay_log?.edges_decayed, 1);
    assertClose(graph.getEdgeById("a-b")?.weight ?? 0, 0.9);
    assertClose(entry.graph_stats?.max_weight ?? 0, 0.9);
    assert.equal(loop.getHealthMetrics().total_ticks, 1);
    assert.equal(logs.length, 1);
  } finally {
    await cleanupPaths(paths);
  }
});

test("SubconsciousLoop records Hebbian updates, final graph stats, and keeps manual spread compatible", async () => {
  const paths = await createTempPaths("yobi-cognition-phase3-loop-hebbian-");
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
      weight: 0.6,
      created_at: 0,
      last_activated_at: 0
    });

    const config: CognitionConfig = {
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
      getUserActivityState: () => ({
        online: true,
        last_active: Date.now()
      }),
      getLastExpressionTime: () => 0,
      setLastExpressionTime: () => {},
      getRecentDialogueResidue: () => [],
      getLastDialogueTime: () => null,
      onProactiveMessage: async () => {},
      onTickCompleted: async () => {}
    });

    const entry = await loop.triggerManualSpread("中午吃什么");

    assert.equal(entry.trigger_type, "manual_signal");
    assert.ok((entry.hebbian_log?.edges_updated ?? 0) >= 1);
    assert.ok((entry.hebbian_log?.avg_weight_after ?? 0) >= 0.6);
    assert.ok((entry.graph_stats?.avg_weight ?? 0) > 0);
    assert.ok((entry.graph_stats?.avg_weight ?? 0) <= (entry.hebbian_log?.avg_weight_after ?? 0));
    assert.equal(entry.activation_peak, entry.top_activated[0]?.activation);
    assert.equal(loop.getRecentLogs(1).length, 1);
  } finally {
    await cleanupPaths(paths);
  }
});
