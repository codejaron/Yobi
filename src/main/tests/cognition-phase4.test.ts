import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG, type AppConfig } from "@shared/types";
import {
  DEFAULT_COGNITION_CONFIG,
  type CognitionConfig,
  type MemoryNode
} from "@shared/cognition";
import { CompanionPaths } from "../storage/paths.js";
import { loadCognitionConfig } from "../cognition/config.js";
import { EmotionStateManager } from "../cognition/workspace/emotion-state.js";
import { computeEmotionModulatedWeight } from "../cognition/activation/emotion-modulation.js";
import { PredictionEngine } from "../cognition/activation/prediction-coding.js";
import { AttentionSchema } from "../cognition/workspace/attention-schema.js";
import { MemoryGraphStore } from "../cognition/graph/memory-graph.js";
import { ThoughtPool } from "../cognition/thoughts/thought-bubble.js";
import { SubconsciousLoop } from "../cognition/loop/subconscious-loop.js";
import { CognitionEngine } from "../cognition/engine.js";
import { GlobalWorkspace } from "../cognition/workspace/global-workspace.js";
import { ensureKernelBootstrap } from "../kernel/init.js";

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

test("phase-four config bootstraps emotion, prediction, and attention defaults", async () => {
  const paths = await createTempPaths("yobi-cognition-phase4-config-");
  try {
    const loaded = await loadCognitionConfig(paths);
    assert.equal(loaded.emotion.modulation_strength, 0.25);
    assert.equal(loaded.emotion.neutral_state.valence, 0.1);
    assert.equal(loaded.prediction.history_window, 5);
    assert.equal(loaded.attention.focus_seed_energy, 0.3);
    assert.equal(loaded.inhibition.lateral_inhibition_top_M, 3);
    assert.equal(loaded.spreading.spreading_size_limit, 50);
  } finally {
    await cleanupPaths(paths);
  }
});

test("EmotionStateManager cold-starts, decays toward neutral, and emotion modulation respects direction", async () => {
  const paths = await createTempPaths("yobi-cognition-phase4-emotion-");
  try {
    const manager = new EmotionStateManager({
      paths,
      logger: { warn() {} } as never,
      getCognitionConfig: () => DEFAULT_COGNITION_CONFIG,
      analyzeEmotion: async () => ({ valence: 0.9, arousal: 0.8 })
    });
    const loaded = await manager.load();
    assert.equal(loaded.source, "cold_start");
    assert.equal(loaded.valence, 0.1);
    assert.equal(loaded.arousal, 0.3);

    manager.setState({
      valence: 0.8,
      arousal: 0.9,
      source: "test"
    });
    const positiveWeight = computeEmotionModulatedWeight(1, 0.9, manager, DEFAULT_COGNITION_CONFIG.emotion);
    const negativeWeight = computeEmotionModulatedWeight(1, -0.9, manager, DEFAULT_COGNITION_CONFIG.emotion);
    const identityWeight = computeEmotionModulatedWeight(1, 0.9, manager, {
      ...DEFAULT_COGNITION_CONFIG.emotion,
      modulation_strength: 0
    });

    assert.equal(identityWeight, 1);
    assert.ok(positiveWeight > 1);
    assert.ok(negativeWeight < 1);

    for (let index = 0; index < 40; index += 1) {
      manager.decay();
    }
    const decayed = manager.getSnapshot();
    assert.ok(Math.abs(decayed.valence - DEFAULT_COGNITION_CONFIG.emotion.neutral_state.valence) < 0.15);
    assert.ok(Math.abs(decayed.arousal - DEFAULT_COGNITION_CONFIG.emotion.neutral_state.arousal) < 0.15);
  } finally {
    await cleanupPaths(paths);
  }
});

test("PredictionEngine warms up for five cycles and persists stable history order", async () => {
  const paths = await createTempPaths("yobi-cognition-phase4-prediction-");
  try {
    const engine = new PredictionEngine({
      paths,
      getCognitionConfig: () => DEFAULT_COGNITION_CONFIG
    });
    await engine.load();

    const allNodeIds = ["c", "a", "b"];
    for (let index = 0; index < 5; index += 1) {
      const result = engine.applyPredictionCoding(new Map([["a", 1]]), allNodeIds);
      assert.equal(result.status, "warming_up");
      assert.equal(result.progress, `${index + 1}/5`);
      engine.recordActivationFingerprint(new Map([["a", 1]]), allNodeIds, index + 1);
    }

    const active = engine.applyPredictionCoding(new Map([["b", 1.2]]), allNodeIds);
    assert.equal(active.status, "active");
    assert.equal(active.progress, "5/5");

    await engine.persist();
    const reloaded = new PredictionEngine({
      paths,
      getCognitionConfig: () => DEFAULT_COGNITION_CONFIG
    });
    const snapshot = await reloaded.load();
    assert.equal(snapshot.progress, "5/5");
    assert.equal(snapshot.history_window, 5);
  } finally {
    await cleanupPaths(paths);
  }
});

test("AttentionSchema updates focus nodes and injects them as future seeds without extra lookup", async () => {
  const paths = await createTempPaths("yobi-cognition-phase4-attention-");
  try {
    const schema = new AttentionSchema({
      paths,
      getCognitionConfig: () => DEFAULT_COGNITION_CONFIG
    });
    await schema.load();
    schema.updateFromActivation({
      activated: new Map([
        ["winner", 1],
        ["runner", 0.6],
        ["third", 0.4]
      ]),
      path_log: []
    });

    const nextSeeds = schema.injectFocusSeeds([
      { nodeId: "manual", energy: 0.9 },
      { nodeId: "winner", energy: 0.1 }
    ]);
    assert.deepEqual(
      nextSeeds.map((seed) => seed.nodeId),
      ["manual", "runner", "third", "winner"]
    );
    assertClose(nextSeeds.find((seed) => seed.nodeId === "winner")?.energy ?? 0, 0.3);
  } finally {
    await cleanupPaths(paths);
  }
});

test("AttentionSchema prunes stale focus ids before reinjecting them as seeds", async () => {
  const paths = await createTempPaths("yobi-cognition-phase4-attention-prune-");
  try {
    const schema = new AttentionSchema({
      paths,
      getCognitionConfig: () => DEFAULT_COGNITION_CONFIG
    });
    await schema.load();
    schema.updateFromActivation({
      activated: new Map([
        ["winner", 1],
        ["runner", 0.6]
      ]),
      path_log: []
    });

    const nextSeeds = schema.injectFocusSeeds(
      [{ nodeId: "manual", energy: 0.9 }],
      { isValidNode: (nodeId) => nodeId !== "runner" }
    );

    assert.deepEqual(nextSeeds.map((seed) => seed.nodeId), ["manual", "winner"]);
    assert.deepEqual(schema.getWorkspaceState().focus_node_ids, ["winner"]);
  } finally {
    await cleanupPaths(paths);
  }
});

test("SubconsciousLoop logs prediction warmup and attention carries top nodes across manual runs", async () => {
  const paths = await createTempPaths("yobi-cognition-phase4-loop-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    graph.addNode(makeNode({ id: "seed", content: "种子", type: "concept", embedding: [1, 0, 0], emotional_valence: 0.8 }));
    graph.addNode(makeNode({ id: "target", content: "目标", type: "fact", embedding: [0, 1, 0], emotional_valence: -0.5 }));
    graph.addEdge({
      id: "seed-target",
      source: "seed",
      target: "target",
      relation_type: "semantic",
      weight: 0.8,
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

    const loop = new SubconsciousLoop({
      graph,
      thoughtPool: new ThoughtPool(paths),
      emotionState,
      predictionEngine,
      attentionSchema,
      globalWorkspace,
      memory: {
        embedText: async (text: string) => (text === "种子" ? [1, 0, 0] : [0, 0, 1]),
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
      getAppConfig: () => ({}) as AppConfig,
      getCognitionConfig: () => config,
      getUserOnline: () => true,
      getLastExpressionTime: () => 0,
      setLastExpressionTime: () => {},
      onProactiveMessage: async () => {},
      onTickCompleted: async () => {}
    });

    const first = await loop.triggerManualSpread("种子");
    assert.equal(first.prediction_status, "warming_up");
    assert.equal(first.prediction_progress, "1/5");
    assert.ok((first.attention_focus?.length ?? 0) > 0);

    const second = await loop.triggerManualSpread("完全无关的话题");
    assert.equal(second.prediction_status, "warming_up");
    assert.equal(second.prediction_progress, "2/5");
    assert.ok(second.seeds.some((seed) => seed.node_id === first.attention_focus?.[0]));
  } finally {
    await cleanupPaths(paths);
  }
});

test("CognitionEngine swallows emotion analysis failures and logs emotion_analysis_skipped", async () => {
  const paths = await createTempPaths("yobi-cognition-phase4-engine-");
  try {
    const warnings: Array<{ event: string; reason?: string }> = [];
    const engine = new CognitionEngine({
      paths,
      getConfig: () => ({}) as AppConfig,
      memory: {
        embedText: async () => [],
        getProfile: async () => ({}) as never,
        listHistoryByCursor: async () => ({ items: [] }) as never
      },
      conversation: {} as never,
      logger: {
        info() {},
        warn(_module: string, event: string, detail?: Record<string, unknown>) {
          warnings.push({ event, reason: typeof detail?.reason === "string" ? detail.reason : undefined });
        },
        error() {}
      } as never
    });

    const emotionState = {
      analyzeDialogue: async () => {
        throw new Error("boom");
      }
    };
    (engine as any).emotionState = emotionState;
    (engine as any).queueEmotionAnalysis("hello");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(warnings[0]?.event, "emotion_analysis_skipped");
    assert.equal(warnings[0]?.reason, "boom");
  } finally {
    await cleanupPaths(paths);
  }
});

test("CognitionEngine batches dialogue ingestion by configured round count", async () => {
  const paths = await createTempPaths("yobi-cognition-batch-rounds-");
  try {
    await ensureKernelBootstrap(paths);

    const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig;
    config.memory.cognitionBatchRounds = 10;

    class TestCognitionEngine extends CognitionEngine {
      readonly batches: Array<Array<{ userText: string; assistantText: string }>> = [];

      protected override async processDialogueBatch(
        rounds: Array<{ userText?: string; assistantText: string }>
      ): Promise<void> {
        this.batches.push(
          rounds.map((round) => ({
            userText: round.userText ?? "",
            assistantText: round.assistantText
          }))
        );
      }
    }

    const engine = new TestCognitionEngine({
      paths,
      getConfig: () => config,
      memory: {
        embedText: async () => [],
        getProfile: async () => ({}) as never,
        listHistoryByCursor: async () => ({ items: [] }) as never
      },
      conversation: {} as never,
      logger: {
        info() {},
        warn() {},
        error() {}
      } as never
    });

    for (let index = 1; index <= 9; index += 1) {
      await engine.ingestDialogue({
        channel: "console",
        userText: `用户第 ${index} 轮`,
        assistantText: `助手第 ${index} 轮`
      });
    }

    assert.equal(engine.batches.length, 0);

    await engine.ingestDialogue({
      channel: "console",
      userText: "用户第 10 轮",
      assistantText: "助手第 10 轮"
    });

    assert.equal(engine.batches.length, 1);
    assert.equal(engine.batches[0]?.length, 10);
    assert.equal(engine.batches[0]?.[0]?.userText, "用户第 1 轮");
    assert.equal(engine.batches[0]?.[9]?.assistantText, "助手第 10 轮");
  } finally {
    await cleanupPaths(paths);
  }
});

test("CognitionEngine.start loads the bundled default graph without requiring a cognition model route", async () => {
  const paths = await createTempPaths("yobi-cognition-bundled-graph-");
  try {
    await ensureKernelBootstrap(paths);

    const engine = new CognitionEngine({
      paths,
      getConfig: () => ({}) as AppConfig,
      memory: {
        embedText: async () => [],
        getProfile: async () => ({}) as never,
        listHistoryByCursor: async () => ({ items: [] }) as never
      },
      conversation: {} as never,
      logger: {
        info() {},
        warn() {},
        error() {}
      } as never
    });

    await assert.doesNotReject(() => engine.start());
    await engine.stop();
  } finally {
    await cleanupPaths(paths);
  }
});

test("CognitionEngine.start prunes stale attention focus ids that do not exist in the current graph", async () => {
  const paths = await createTempPaths("yobi-cognition-attention-prune-engine-");
  try {
    await ensureKernelBootstrap(paths);
    await fs.writeFile(
      paths.cognitionAttentionFocusPath,
      JSON.stringify({
        focusNodeIds: ["04fb6be5-bf04-4687-9862-b197eaa2249e", "person:user"],
        last_updated: new Date().toISOString()
      }),
      "utf8"
    );

    const engine = new CognitionEngine({
      paths,
      getConfig: () => ({}) as AppConfig,
      memory: {
        embedText: async () => [],
        getProfile: async () => ({}) as never,
        listHistoryByCursor: async () => ({ items: [] }) as never
      },
      conversation: {} as never,
      logger: {
        info() {},
        warn() {},
        error() {}
      } as never
    });

    const snapshot = await engine.getDebugSnapshot();
    assert.deepEqual(snapshot.workspace.attention?.focus_node_ids, ["person:user"]);

    const persisted = JSON.parse(await fs.readFile(paths.cognitionAttentionFocusPath, "utf8")) as {
      focusNodeIds?: string[];
    };
    assert.deepEqual(persisted.focusNodeIds, ["person:user"]);

    await engine.stop();
  } finally {
    await cleanupPaths(paths);
  }
});

test("CognitionEngine forwards proactive delivery results from the runtime callback", async () => {
  const paths = await createTempPaths("yobi-cognition-proactive-delivery-");
  try {
    await ensureKernelBootstrap(paths);

    const engine = new CognitionEngine({
      paths,
      getConfig: () => ({}) as AppConfig,
      memory: {
        embedText: async () => [],
        getProfile: async () => ({}) as never,
        listHistoryByCursor: async () => ({ items: [] }) as never
      },
      conversation: {} as never,
      logger: {
        info() {},
        warn() {},
        error() {}
      } as never,
      onProactiveMessage: async () => false
    });

    await engine.start();

    const delivered = await (engine as any).loop.input.onProactiveMessage({
      message: "test proactive"
    });

    assert.equal(delivered, false);

    await engine.stop();
  } finally {
    await cleanupPaths(paths);
  }
});

test("CognitionEngine.regenerateGraphFromSoul reuses the bundled default graph when soul is still default", async () => {
  const paths = await createTempPaths("yobi-cognition-default-regenerate-");
  try {
    await ensureKernelBootstrap(paths);

    const engine = new CognitionEngine({
      paths,
      getConfig: () => ({}) as AppConfig,
      memory: {
        embedText: async () => [],
        getProfile: async () => ({}) as never,
        listHistoryByCursor: async () => ({ items: [] }) as never
      },
      conversation: {} as never,
      logger: {
        info() {},
        warn() {},
        error() {}
      } as never
    });

    await assert.doesNotReject(() => engine.start());
    await assert.doesNotReject(() => engine.regenerateGraphFromSoul());
    await engine.stop();
  } finally {
    await cleanupPaths(paths);
  }
});
