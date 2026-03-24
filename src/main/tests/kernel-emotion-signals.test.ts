import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceEmotionalRumination,
  applyElapsedEmotionalDecay,
  applyEmotionalSignalsToState,
  applyRealtimeEmotionalSignals,
  computeSignalAgeScale
} from "../kernel/engine.js";
import {
  createDefaultEmotionalState,
  DEFAULT_OCEAN_PERSONALITY,
  type EmotionalState
} from "@shared/types";
import type { KernelEmotionSignalsConfig } from "@shared/runtime-tuning";

const emotionSignalConfig: KernelEmotionSignalsConfig = {
  enabled: true,
  deltaScale: 0.4,
  energyEngagementScale: 0.1,
  connectionTrustScale: 0.5,
  ruminationThreshold: 0.7,
  ruminationMaxStages: 4,
  windowMaxAbsDelta: 0.2,
  stalenessFullEffectMinutes: 30,
  stalenessMaxAgeHours: 24,
  stalenessMinScale: 0.15
};

const baseEmotional: EmotionalState = {
  ...createDefaultEmotionalState(),
  dimensions: {
    ...createDefaultEmotionalState().dimensions,
    curiosity: 0.4
  },
  connection: 0.5
};

function assertApprox(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} ≈ ${expected}`);
}

test("computeSignalAgeScale: 在 fullEffect 内保持 1", () => {
  const now = new Date("2026-03-04T12:00:00.000Z");
  const scale = computeSignalAgeScale("2026-03-04T11:45:00.000Z", now, emotionSignalConfig);
  assert.equal(scale, 1);
});

test("computeSignalAgeScale: 中间区间线性衰减", () => {
  const now = new Date("2026-03-04T12:00:00.000Z");
  const scale = computeSignalAgeScale("2026-03-04T10:00:00.000Z", now, emotionSignalConfig);
  assert.ok(scale < 1);
  assert.ok(scale > emotionSignalConfig.stalenessMinScale);
});

test("computeSignalAgeScale: 超过 maxAge 变为 0", () => {
  const now = new Date("2026-03-05T12:00:00.000Z");
  const scale = computeSignalAgeScale("2026-03-04T11:59:00.000Z", now, emotionSignalConfig);
  assert.equal(scale, 0);
});

test("applyEmotionalSignalsToState: 正向标签驱动 PAD、Ekman、trust 和 energy", () => {
  const next = applyEmotionalSignalsToState({
    emotional: baseEmotional,
    personality: DEFAULT_OCEAN_PERSONALITY,
    ruminationQueue: [],
    signals: {
      emotion_label: "happy",
      intensity: 0.8,
      engagement: 0.8,
      trust_delta: 0.08
    },
    config: emotionSignalConfig,
    ageScale: 1
  });

  assert.ok(next.emotional.dimensions.pleasure > baseEmotional.dimensions.pleasure);
  assert.ok(next.emotional.dimensions.energy > baseEmotional.dimensions.energy);
  assert.ok(next.emotional.dimensions.trust > baseEmotional.dimensions.trust);
  assert.ok(next.emotional.connection > baseEmotional.connection);
  assert.ok(next.emotional.ekman.happiness > 0);
  assert.equal(next.ruminationQueue.length, 0);
});

test("applyEmotionalSignalsToState: 强烈负向标签会触发 rumination", () => {
  const next = applyEmotionalSignalsToState({
    emotional: baseEmotional,
    personality: DEFAULT_OCEAN_PERSONALITY,
    ruminationQueue: [],
    signals: {
      emotion_label: "frustrated",
      intensity: 0.95,
      engagement: 0.3,
      trust_delta: -0.08
    },
    config: emotionSignalConfig,
    ageScale: 1
  });

  assert.ok(next.emotional.dimensions.pleasure < baseEmotional.dimensions.pleasure);
  assert.ok(next.emotional.dimensions.arousal > baseEmotional.dimensions.arousal);
  assert.ok(next.emotional.ekman.anger > 0);
  assert.equal(next.ruminationQueue.length, 1);
  assert.equal(next.ruminationQueue[0]?.label, "frustrated");
  assert.equal(next.ruminationQueue[0]?.remainingStages, 4);
});

test("applyEmotionalSignalsToState: trust_delta 按 connectionTrustScale 传递给 connection", () => {
  const next = applyEmotionalSignalsToState({
    emotional: baseEmotional,
    personality: DEFAULT_OCEAN_PERSONALITY,
    ruminationQueue: [],
    signals: {
      emotion_label: "neutral",
      intensity: 0.5,
      engagement: 1,
      trust_delta: 0.3
    },
    config: {
      ...emotionSignalConfig,
      windowMaxAbsDelta: 0.05
    },
    ageScale: 1
  });

  assertApprox(next.emotional.dimensions.trust, 0.55);
  assertApprox(next.emotional.connection, 0.525);
});

test("applyRealtimeEmotionalSignals: 过期信号会按 staleness 配置失效", () => {
  const next = applyRealtimeEmotionalSignals({
    emotional: baseEmotional,
    personality: DEFAULT_OCEAN_PERSONALITY,
    ruminationQueue: [],
    signals: {
      emotion_label: "happy",
      intensity: 0.8,
      engagement: 0.8,
      trust_delta: 0.08
    },
    config: emotionSignalConfig,
    latestMessageTs: "2026-03-03T12:00:00.000Z",
    now: new Date("2026-03-04T12:00:00.000Z")
  });

  assert.deepEqual(next, {
    emotional: baseEmotional,
    ruminationQueue: []
  });
});

test("applyRealtimeEmotionalSignals: 无信号时保持原状态", () => {
  const next = applyRealtimeEmotionalSignals({
    emotional: baseEmotional,
    personality: DEFAULT_OCEAN_PERSONALITY,
    ruminationQueue: [],
    signals: null,
    config: emotionSignalConfig
  });

  assert.deepEqual(next, {
    emotional: baseEmotional,
    ruminationQueue: []
  });
});

test("applyElapsedEmotionalDecay: PAD 和 Ekman 分别向 baseline/0 回归", () => {
  const next = applyElapsedEmotionalDecay({
    emotional: {
      ...baseEmotional,
      dimensions: {
        ...baseEmotional.dimensions,
        pleasure: 0.8
      },
      ekman: {
        ...baseEmotional.ekman,
        anger: 0.4
      },
      connection: 0.9
    },
    personality: DEFAULT_OCEAN_PERSONALITY,
    deltaSeconds: 12 * 60 * 60
  });

  assert.ok(next.dimensions.pleasure < 0.8);
  assert.ok(next.dimensions.pleasure > 0);
  assert.ok(next.ekman.anger < 0.4);
  assert.ok(next.ekman.anger > 0);
  assert.ok(next.connection < 0.9);
  assert.ok(next.connection > 0.25);
});

test("applyElapsedEmotionalDecay: connection 在 48 小时半衰期后回到一半增量", () => {
  const next = applyElapsedEmotionalDecay({
    emotional: {
      ...baseEmotional,
      connection: 1
    },
    personality: DEFAULT_OCEAN_PERSONALITY,
    deltaSeconds: 48 * 60 * 60
  });

  assertApprox(next.connection, 0.625);
});

test("advanceEmotionalRumination: 先施加本轮影响，再推进阶段和强度", () => {
  const next = advanceEmotionalRumination({
    emotional: baseEmotional,
    ruminationQueue: [
      {
        label: "angry",
        intensity: 0.9,
        remainingStages: 4,
        triggeredAt: "2026-03-04T12:00:00.000Z"
      }
    ]
  });

  assert.ok(next.emotional.dimensions.pleasure < baseEmotional.dimensions.pleasure);
  assert.ok(next.emotional.ekman.anger > baseEmotional.ekman.anger);
  assert.equal(next.ruminationQueue[0]?.remainingStages, 3);
  assertApprox(next.ruminationQueue[0]?.intensity ?? 0, 0.72);
});
