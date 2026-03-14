import test from "node:test";
import assert from "node:assert/strict";
import {
  applyElapsedEmotionalDecay,
  applyEmotionalSignalsToState,
  applyRealtimeEmotionalSignals,
  computeSignalAgeScale
} from "../kernel/engine.js";
import type { AppConfig, EmotionalState } from "@shared/types";

const emotionSignalConfig: AppConfig["kernel"]["emotionSignals"] = {
  enabled: true,
  deltaScale: 0.4,
  moodPositiveStep: 0.12,
  moodNegativeStep: 0.08,
  energyEngagementScale: 0.1,
  curiosityBoost: 0.15,
  confidenceGain: 0.02,
  confidenceDropOnFriction: 0.1,
  irritationBoostOnFriction: 0.12,
  minPositiveEngagement: 0.6,
  minPositiveTrustDelta: 0.03,
  windowMaxAbsDelta: 0.2,
  stalenessFullEffectMinutes: 30,
  stalenessMaxAgeHours: 24,
  stalenessMinScale: 0.15
};

const baseEmotional: EmotionalState = {
  mood: 0,
  energy: 0.6,
  connection: 0.5,
  curiosity: 0.4,
  confidence: 0.5,
  irritation: 0.1
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

test("applyEmotionalSignalsToState: 正向信号驱动 mood/curiosity/confidence 增长", () => {
  const next = applyEmotionalSignalsToState({
    emotional: baseEmotional,
    signals: {
      user_mood: "positive",
      engagement: 0.8,
      trust_delta: 0.08,
      friction: false,
      curiosity_trigger: true
    },
    config: emotionSignalConfig,
    ageScale: 1
  });

  assertApprox(next.mood, 0.048);
  assertApprox(next.energy, 0.612);
  assertApprox(next.connection, 0.532);
  assertApprox(next.curiosity, 0.46);
  assertApprox(next.confidence, 0.516);
  assertApprox(next.irritation, 0.1);
});

test("applyEmotionalSignalsToState: friction 会压 confidence 并推高 irritation", () => {
  const next = applyEmotionalSignalsToState({
    emotional: baseEmotional,
    signals: {
      user_mood: "mixed",
      engagement: 0.9,
      trust_delta: 0.2,
      friction: true,
      curiosity_trigger: false
    },
    config: emotionSignalConfig,
    ageScale: 1
  });

  assertApprox(next.confidence, 0.48);
  assertApprox(next.irritation, 0.148);
});

test("applyEmotionalSignalsToState: 单窗变化受 windowMaxAbsDelta 限幅", () => {
  const next = applyEmotionalSignalsToState({
    emotional: baseEmotional,
    signals: {
      user_mood: "positive",
      engagement: 1,
      trust_delta: 0.3,
      friction: false,
      curiosity_trigger: true
    },
    config: {
      ...emotionSignalConfig,
      windowMaxAbsDelta: 0.05
    },
    ageScale: 1
  });

  assertApprox(next.mood, 0.048);
  assertApprox(next.connection, 0.55);
  assertApprox(next.curiosity, 0.45);
});

test("applyRealtimeEmotionalSignals: 过期信号会按 staleness 配置衰减", () => {
  const next = applyRealtimeEmotionalSignals({
    emotional: baseEmotional,
    signals: {
      user_mood: "positive",
      engagement: 0.8,
      trust_delta: 0.08,
      friction: false,
      curiosity_trigger: true
    },
    config: emotionSignalConfig,
    latestMessageTs: "2026-03-03T12:00:00.000Z",
    now: new Date("2026-03-04T12:00:00.000Z")
  });

  assert.deepEqual(next, baseEmotional);
});

test("applyRealtimeEmotionalSignals: 有信号时按实时窗口更新情绪", () => {
  const next = applyRealtimeEmotionalSignals({
    emotional: baseEmotional,
    signals: {
      user_mood: "negative",
      engagement: 0.2,
      trust_delta: -0.08,
      friction: true,
      curiosity_trigger: false
    },
    config: emotionSignalConfig
  });

  assert.ok(next.mood < baseEmotional.mood);
  assert.ok(next.energy < baseEmotional.energy);
  assert.ok(next.connection < baseEmotional.connection);
  assert.ok(next.irritation > baseEmotional.irritation);
});

test("applyRealtimeEmotionalSignals: 无信号时保持原状态", () => {
  const next = applyRealtimeEmotionalSignals({
    emotional: baseEmotional,
    signals: null,
    config: emotionSignalConfig
  });

  assert.deepEqual(next, baseEmotional);
});


test("applyElapsedEmotionalDecay: 按时间向默认基线指数回归", () => {
  const next = applyElapsedEmotionalDecay(
    {
      ...baseEmotional,
      mood: 0.8,
      connection: 0.9,
      irritation: 0.4
    },
    12 * 60 * 60
  );

  assert.ok(next.mood < 0.8);
  assert.ok(next.mood > 0);
  assert.ok(next.connection < 0.9);
  assert.ok(next.connection > 0.5);
  assert.ok(next.irritation < 0.4);
  assert.ok(next.irritation > 0.1);
});

test("applyElapsedEmotionalDecay: connection 在 48 小时半衰期后回到一半增量", () => {
  const next = applyElapsedEmotionalDecay(
    {
      ...baseEmotional,
      connection: 1
    },
    48 * 60 * 60
  );

  assertApprox(next.connection, 0.625);
});
