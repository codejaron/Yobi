/*
 * Adapted from OpenFeelz (https://github.com/trianglegrrl/openfeelz), MIT License.
 * Source basis: src/model/decay.ts from OpenFeelz v1.1.1.
 */

import type { EkmanEmotions, EmotionalDimensions } from "@shared/types";
import { clampDimension, clampEmotion, DIMENSION_NAMES, EKMAN_EMOTION_NAMES } from "./emotion-model";
import type { DimensionDecayRates, EkmanDecayRates } from "./personality";

export function decayTowardBaseline(
  current: number,
  baseline: number,
  rate: number,
  elapsedHours: number
): number {
  if (elapsedHours <= 0) {
    return current;
  }

  return baseline + (current - baseline) * Math.exp(-rate * elapsedHours);
}

export function decayDimensions(
  state: EmotionalDimensions,
  baseline: EmotionalDimensions,
  rates: DimensionDecayRates,
  elapsedHours: number
): EmotionalDimensions {
  const next = { ...state };
  for (const name of DIMENSION_NAMES) {
    next[name] = clampDimension(name, decayTowardBaseline(state[name], baseline[name], rates[name], elapsedHours));
  }
  return next;
}

export function decayEkman(
  emotions: EkmanEmotions,
  rates: EkmanDecayRates,
  elapsedHours: number
): EkmanEmotions {
  const next = { ...emotions };
  for (const name of EKMAN_EMOTION_NAMES) {
    next[name] = clampEmotion(decayTowardBaseline(emotions[name], 0, rates[name], elapsedHours));
  }
  return next;
}
