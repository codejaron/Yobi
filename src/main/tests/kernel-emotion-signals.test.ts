import test from "node:test";
import assert from "node:assert/strict";
import {
  applyEmotionalSignalsToState,
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

  assert.equal(next.mood, 0.12);
  assert.equal(next.energy, 0.63);
  assert.equal(next.connection, 0.58);
  assert.equal(next.curiosity, 0.55);
  assert.equal(next.confidence, 0.52);
  assert.equal(next.irritation, 0.1);
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

  assert.equal(next.confidence, 0.4);
  assert.equal(next.irritation, 0.22);
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

  assert.equal(next.mood, 0.05);
  assert.equal(next.connection, 0.55);
  assert.equal(next.curiosity, 0.45);
});
