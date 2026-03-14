import test from "node:test";
import assert from "node:assert/strict";
import { shouldPublishEmotionState } from "../pet/emotion-state-sync.js";
import {
  DEFAULT_PET_EMOTION_CONFIG,
  mergePetEmotionConfig,
  normalizePetEmotionName
} from "@shared/pet-emotion";
import { createDefaultEmotionalState, type EmotionalState } from "@shared/types";

const baseEmotion: EmotionalState = createDefaultEmotionalState();

test("shouldPublishEmotionState: 首次发布直接通过", () => {
  const result = shouldPublishEmotionState({
    previous: null,
    next: baseEmotion,
    epsilon: 0.02,
    heartbeatMs: 2000,
    nowMs: 1000,
    lastPublishedAtMs: 0
  });

  assert.equal(result, true);
});

test("shouldPublishEmotionState: 等于 epsilon 的单步变化也会发送", () => {
  const result = shouldPublishEmotionState({
    previous: baseEmotion,
    next: {
      ...baseEmotion,
      dimensions: {
        ...baseEmotion.dimensions,
        trust: 0.52
      }
    },
    epsilon: 0.02,
    heartbeatMs: 2000,
    nowMs: 1500,
    lastPublishedAtMs: 1000
  });

  assert.equal(result, true);
});

test("shouldPublishEmotionState: 小于 epsilon 且未到 heartbeat 时不发送", () => {
  const result = shouldPublishEmotionState({
    previous: baseEmotion,
    next: {
      ...baseEmotion,
      dimensions: {
        ...baseEmotion.dimensions,
        trust: 0.519
      }
    },
    epsilon: 0.02,
    heartbeatMs: 2000,
    nowMs: 2500,
    lastPublishedAtMs: 1000
  });

  assert.equal(result, false);
});

test("shouldPublishEmotionState: heartbeat 到达时强制同步", () => {
  const result = shouldPublishEmotionState({
    previous: baseEmotion,
    next: {
      ...baseEmotion,
      dimensions: {
        ...baseEmotion.dimensions,
        trust: 0.519
      }
    },
    epsilon: 0.02,
    heartbeatMs: 2000,
    nowMs: 3000,
    lastPublishedAtMs: 1000
  });

  assert.equal(result, true);
});

test("shouldPublishEmotionState: sessionWarmth 变化会触发同步", () => {
  const result = shouldPublishEmotionState({
    previous: baseEmotion,
    next: {
      ...baseEmotion,
      sessionWarmth: 0.3
    },
    epsilon: 0.02,
    heartbeatMs: 2000,
    nowMs: 1500,
    lastPublishedAtMs: 1000
  });

  assert.equal(result, true);
});

test("normalizePetEmotionName: 兼容 legacy emotion tag", () => {
  assert.equal(normalizePetEmotionName("Happy"), "happy");
  assert.equal(normalizePetEmotionName(" calm "), null);
  assert.equal(normalizePetEmotionName("unknown"), null);
});

test("mergePetEmotionConfig: 允许局部覆盖 impulse 默认值和 alias", () => {
  const merged = mergePetEmotionConfig(DEFAULT_PET_EMOTION_CONFIG, {
    aliases: {
      mouthForm: ["CustomMouthForm"]
    },
    impulses: {
      angry: {
        durationMs: 1600
      }
    }
  });

  assert.deepEqual(merged.aliases.mouthForm, ["CustomMouthForm"]);
  assert.equal(merged.impulses.angry.durationMs, 1600);
  assert.equal(merged.impulses.angry.intensity, DEFAULT_PET_EMOTION_CONFIG.impulses.angry.intensity);
});
