import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_COGNITION_CONFIG,
  type CognitionConfig,
  type MemoryNode,
  type ThoughtBubble
} from "@shared/cognition";
import { CompanionPaths } from "../storage/paths.js";
import { loadCognitionConfig } from "../cognition/config.js";
import { MemoryGraphStore } from "../cognition/graph/memory-graph.js";
import { EmotionStateManager } from "../cognition/workspace/emotion-state.js";
import { PredictionEngine } from "../cognition/activation/prediction-coding.js";
import { AttentionSchema } from "../cognition/workspace/attention-schema.js";
import { GlobalWorkspace } from "../cognition/workspace/global-workspace.js";

function assertClose(actual: number, expected: number, epsilon = 1e-6): void {
  assert.ok(Math.abs(actual - expected) < epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
}

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

async function createWorkspace(paths: CompanionPaths, config: CognitionConfig, graph: MemoryGraphStore) {
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

test("phase-five config bootstraps workspace defaults", async () => {
  const paths = await createTempPaths("yobi-cognition-phase5-config-");
  try {
    const loaded = await loadCognitionConfig(paths);
    assert.equal(loaded.workspace.broadcast_enabled, true);
    assert.equal(loaded.workspace.broadcast_snapshot_top_n, 30);
    assert.equal(loaded.workspace.broadcast_hebbian_rate, 0.02);
    assert.equal(loaded.workspace.broadcast_prediction_weight, 1.5);
    assert.equal(loaded.workspace.broadcast_history_max, 20);
  } finally {
    await cleanupPaths(paths);
  }
});

test("PredictionEngine uses weighted broadcast fingerprints and skips duplicate tick ids", async () => {
  const paths = await createTempPaths("yobi-cognition-phase5-prediction-");
  try {
    const config: CognitionConfig = {
      ...DEFAULT_COGNITION_CONFIG,
      prediction: {
        ...DEFAULT_COGNITION_CONFIG.prediction,
        history_window: 2
      }
    };
    const engine = new PredictionEngine({
      paths,
      getCognitionConfig: () => config
    });
    await engine.load();

    const nodeIds = ["a", "b"];
    engine.recordActivationFingerprint(new Map([["a", 1]]), nodeIds, 1);
    engine.integrateSuccessfulBroadcast(new Map([["b", 1]]), nodeIds, 3, 2);

    const result = engine.applyPredictionCoding(new Map([["b", 1.2]]), nodeIds);
    assert.equal(result.status, "active");
    assert.equal(result.familiarNodes[0]?.node_id, "b");
    assert.equal(engine.lastRecordedTickId, 2);

    engine.recordActivationFingerprint(new Map([["a", 0.5]]), nodeIds, 2);
    await engine.persist();
    const raw = JSON.parse(await fs.readFile(paths.cognitionPredictionVectorPath, "utf8")) as {
      history: Array<{ fingerprint: number[]; weight: number }>;
      last_recorded_tick_id: number;
    };
    assert.equal(raw.history.length, 2);
    assert.equal(raw.history[1]?.weight, 3);
    assert.equal(raw.last_recorded_tick_id, 2);
  } finally {
    await cleanupPaths(paths);
  }
});

test("AttentionSchema prepends broadcast focus nodes and keeps max_focus_nodes cap", async () => {
  const paths = await createTempPaths("yobi-cognition-phase5-attention-");
  try {
    const schema = new AttentionSchema({
      paths,
      getCognitionConfig: () => DEFAULT_COGNITION_CONFIG
    });
    await schema.load();
    schema.updateFromActivation({
      activated: new Map([
        ["older-a", 0.9],
        ["older-b", 0.8],
        ["older-c", 0.7]
      ]),
      path_log: []
    });

    const bubble: ThoughtBubble = {
      id: "bubble",
      summary: "广播测试",
      source_seeds: ["seed"],
      activated_nodes: [
        { node_id: "fresh-a", activation: 1.2 },
        { node_id: "fresh-b", activation: 1.1 },
        { node_id: "older-b", activation: 1.0 },
        { node_id: "fresh-c", activation: 0.8 }
      ],
      activation_peak: 1.2,
      emotional_tone: 0.4,
      novelty_score: 1,
      created_at: Date.now(),
      last_reinforced_at: Date.now(),
      status: "mature"
    };

    const next = schema.updateFromBroadcast(bubble);
    assert.deepEqual(next.focus_node_ids.slice(0, 3), ["fresh-a", "fresh-b", "older-b"]);
    assert.ok(next.focus_node_ids.length <= DEFAULT_COGNITION_CONFIG.attention.max_focus_nodes);
  } finally {
    await cleanupPaths(paths);
  }
});

test("GlobalWorkspace fan-outs broadcast to graph, emotion, prediction, and attention", async () => {
  const paths = await createTempPaths("yobi-cognition-phase5-workspace-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    graph.addNode(makeNode({ id: "seed", content: "源节点", type: "concept", embedding: [1, 0, 0], emotional_valence: 0.1 }));
    graph.addNode(makeNode({ id: "a", content: "节点 A", type: "fact", embedding: [0, 1, 0], emotional_valence: 0.5 }));
    graph.addNode(makeNode({ id: "b", content: "节点 B", type: "fact", embedding: [0, 0, 1], emotional_valence: 0.4 }));
    graph.addEdge({
      id: "seed-a",
      source: "seed",
      target: "a",
      relation_type: "semantic",
      weight: 0.2,
      created_at: 0,
      last_activated_at: 0
    });
    graph.addEdge({
      id: "seed-b",
      source: "seed",
      target: "b",
      relation_type: "semantic",
      weight: 0.22,
      created_at: 0,
      last_activated_at: 0
    });

    const workspace = await createWorkspace(paths, DEFAULT_COGNITION_CONFIG, graph);
    const bubble: ThoughtBubble = {
      id: "bubble-1",
      summary: "测试广播",
      source_seeds: ["seed"],
      activated_nodes: [
        { node_id: "seed", activation: 1.0 },
        { node_id: "a", activation: 0.9 },
        { node_id: "b", activation: 0.8 }
      ],
      activation_peak: 1,
      emotional_tone: 0.6,
      novelty_score: 1,
      created_at: Date.now(),
      last_reinforced_at: Date.now(),
      status: "expressed"
    };

    const beforeSeedA = graph.getEdgeById("seed-a")?.weight ?? 0;
    const beforeEmotion = workspace.emotionState.getSnapshot();

    const result = workspace.globalWorkspace.broadcast({
      selectedBubble: bubble,
      rawActivationResult: new Map([
        ["seed", 1],
        ["a", 0.9],
        ["b", 0.8]
      ]),
      allNodeIds: ["seed", "a", "b"],
      currentTickId: 7,
      regularDeltaByEdgeId: new Map([["seed-a", 0.11]])
    });

    assert.equal(result.packet.activation_snapshot.length, 3);
    const afterSeedA = graph.getEdgeById("seed-a")?.weight ?? 0;
    const expectedSeedADelta =
      DEFAULT_COGNITION_CONFIG.workspace.broadcast_hebbian_rate *
      (1 * 0.9 - DEFAULT_COGNITION_CONFIG.hebbian.decay_lambda * beforeSeedA);
    assertClose(afterSeedA - beforeSeedA, expectedSeedADelta, 1e-9);

    assert.ok((graph.getNode("seed")?.metadata.reinforcement_count as number) >= 1);
    const afterEmotion = workspace.emotionState.getSnapshot();
    assertClose(
      afterEmotion.valence,
      beforeEmotion.valence + DEFAULT_COGNITION_CONFIG.workspace.broadcast_emotion_alpha * (0.6 - beforeEmotion.valence)
    );
    assert.equal(workspace.predictionEngine.lastRecordedTickId, 7);
    await workspace.predictionEngine.persist();
    const predictionState = JSON.parse(await fs.readFile(paths.cognitionPredictionVectorPath, "utf8")) as {
      history: Array<{ fingerprint: number[]; weight: number }>;
    };
    assert.equal(predictionState.history.length, 1);
    assert.equal(predictionState.history[0]?.weight, DEFAULT_COGNITION_CONFIG.workspace.broadcast_prediction_weight);
    assert.deepEqual(
      workspace.attentionSchema.getWorkspaceState().focus_node_ids.slice(0, 3),
      ["seed", "a", "b"]
    );
    assert.equal(workspace.globalWorkspace.getBroadcastHistory().length, 1);
    assert.equal(result.hebbian_report?.overlap_warning, true);
  } finally {
    await cleanupPaths(paths);
  }
});

test("GlobalWorkspace isolates single-module failures and records them in result", async () => {
  const paths = await createTempPaths("yobi-cognition-phase5-workspace-error-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    graph.addNode(makeNode({ id: "seed", content: "源节点", type: "concept", embedding: [1, 0], emotional_valence: 0.2 }));
    graph.addNode(makeNode({ id: "target", content: "目标", type: "fact", embedding: [0, 1], emotional_valence: 0.3 }));
    graph.addEdge({
      id: "seed-target",
      source: "seed",
      target: "target",
      relation_type: "semantic",
      weight: 0.2,
      created_at: 0,
      last_activated_at: 0
    });
    const workspace = await createWorkspace(paths, DEFAULT_COGNITION_CONFIG, graph);
    const originalIntegrate = workspace.predictionEngine.integrateSuccessfulBroadcast.bind(workspace.predictionEngine);
    workspace.predictionEngine.integrateSuccessfulBroadcast = (() => {
      throw new Error("prediction boom");
    }) as typeof workspace.predictionEngine.integrateSuccessfulBroadcast;

    const result = workspace.globalWorkspace.broadcast({
      selectedBubble: {
        id: "bubble-2",
        summary: "错误广播",
        source_seeds: ["seed"],
        activated_nodes: [
          { node_id: "seed", activation: 1 },
          { node_id: "target", activation: 0.8 }
        ],
        activation_peak: 1,
        emotional_tone: 0.4,
        novelty_score: 1,
        created_at: Date.now(),
        last_reinforced_at: Date.now(),
        status: "expressed"
      },
      rawActivationResult: new Map([
        ["seed", 1],
        ["target", 0.8]
      ]),
      allNodeIds: ["seed", "target"],
      currentTickId: 8
    });

    assert.equal(result.errors[0]?.module_name, "prediction");
    assert.ok(result.hebbian_report);
    assert.ok(result.emotion_report?.success);
    assert.ok(result.attention_report?.success);

    workspace.predictionEngine.integrateSuccessfulBroadcast = originalIntegrate;
  } finally {
    await cleanupPaths(paths);
  }
});
