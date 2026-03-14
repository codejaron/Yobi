/*
 * Adapted from OpenFeelz (https://github.com/trianglegrrl/openfeelz), MIT License.
 * Source basis: src/model/rumination.ts from OpenFeelz v1.1.1.
 */

import type { EkmanEmotions, EmotionalDimensions, RuminationEntry } from "@shared/types";
import { applyEmotionMapping } from "./mapping";

const MIN_INTENSITY = 0.05;
const RUMINATION_EFFECT_SCALE = 0.3;

export function shouldStartRumination(
  intensity: number,
  threshold: number,
  probability: number
): boolean {
  if (probability <= 0 || intensity <= threshold) {
    return false;
  }
  if (probability >= 1) {
    return true;
  }
  const adjustedThreshold = threshold + (1 - probability) * 0.3;
  return intensity > adjustedThreshold;
}

export function applyRuminationEffects(
  ruminationQueue: RuminationEntry[],
  dimensions: EmotionalDimensions,
  emotions: EkmanEmotions
): { dimensions: EmotionalDimensions; emotions: EkmanEmotions } {
  let nextDimensions = { ...dimensions };
  let nextEmotions = { ...emotions };

  for (const entry of ruminationQueue) {
    const result = applyEmotionMapping(
      nextDimensions,
      nextEmotions,
      entry.label,
      Math.max(0, entry.intensity) * RUMINATION_EFFECT_SCALE
    );
    nextDimensions = result.dimensions;
    nextEmotions = result.emotions;
  }

  return {
    dimensions: nextDimensions,
    emotions: nextEmotions
  };
}

export function advanceRuminationQueue(ruminationQueue: RuminationEntry[]): RuminationEntry[] {
  return ruminationQueue.flatMap((entry) => {
    const remainingStages = entry.remainingStages - 1;
    const intensity = entry.intensity * 0.8;
    if (remainingStages <= 0 || intensity < MIN_INTENSITY) {
      return [];
    }
    return [
      {
        ...entry,
        remainingStages,
        intensity
      }
    ];
  });
}
