/*
 * Adapted from OpenFeelz (https://github.com/trianglegrrl/openfeelz), MIT License.
 * Source basis: src/model/emotion-model.ts from OpenFeelz v1.1.1.
 */

import type { EkmanEmotions, EmotionalDimensions } from "@shared/types";

export const DIMENSION_NAMES = [
  "pleasure",
  "arousal",
  "dominance",
  "curiosity",
  "energy",
  "trust"
] as const;

export const EKMAN_EMOTION_NAMES = [
  "happiness",
  "sadness",
  "anger",
  "fear",
  "disgust",
  "surprise"
] as const;

export type DimensionName = (typeof DIMENSION_NAMES)[number];
export type EkmanEmotionName = (typeof EKMAN_EMOTION_NAMES)[number];

export function clampDimension(name: DimensionName, value: number): number {
  if (name === "pleasure" || name === "arousal" || name === "dominance") {
    return Math.max(-1, Math.min(1, value));
  }
  return Math.max(0, Math.min(1, value));
}

export function clampEmotion(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function clampDimensions(state: EmotionalDimensions): EmotionalDimensions {
  const next = { ...state };
  for (const name of DIMENSION_NAMES) {
    next[name] = clampDimension(name, next[name]);
  }
  return next;
}

export function clampEkman(emotions: EkmanEmotions): EkmanEmotions {
  const next = { ...emotions };
  for (const name of EKMAN_EMOTION_NAMES) {
    next[name] = clampEmotion(next[name]);
  }
  return next;
}
