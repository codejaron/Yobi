/*
 * Adapted from OpenFeelz (https://github.com/trianglegrrl/openfeelz), MIT License.
 * Source basis: src/model/mapping.ts from OpenFeelz v1.1.1.
 */

import type { EkmanEmotions, EmotionalDimensions } from "@shared/types";
import { clampDimension, clampEmotion } from "./emotion-model";

export interface EmotionDimensionDelta {
  dimensions: Record<string, number>;
  emotions: Partial<EkmanEmotions>;
}

export const ALL_EMOTION_MAPPINGS: Record<string, EmotionDimensionDelta> = {
  happy: {
    dimensions: { pleasure: 0.2, arousal: 0.1, energy: 0.05 },
    emotions: { happiness: 0.3 }
  },
  excited: {
    dimensions: { pleasure: 0.15, arousal: 0.25, energy: 0.1 },
    emotions: { happiness: 0.2, surprise: 0.1 }
  },
  calm: {
    dimensions: { pleasure: 0.1, arousal: -0.15, energy: 0.05 },
    emotions: { happiness: 0.05 }
  },
  relieved: {
    dimensions: { pleasure: 0.15, arousal: -0.1, energy: 0.05 },
    emotions: { happiness: 0.1 }
  },
  optimistic: {
    dimensions: { pleasure: 0.15, arousal: 0.05, energy: 0.1 },
    emotions: { happiness: 0.15 }
  },
  energized: {
    dimensions: { pleasure: 0.1, arousal: 0.15, energy: 0.25 },
    emotions: { happiness: 0.1 }
  },
  sad: {
    dimensions: { pleasure: -0.2, arousal: -0.15, energy: -0.1 },
    emotions: { sadness: 0.3 }
  },
  angry: {
    dimensions: { pleasure: -0.15, arousal: 0.25, dominance: 0.1, trust: -0.05 },
    emotions: { anger: 0.3 }
  },
  frustrated: {
    dimensions: { pleasure: -0.1, arousal: 0.15, dominance: -0.05, energy: -0.05 },
    emotions: { anger: 0.2 }
  },
  fearful: {
    dimensions: { pleasure: -0.15, arousal: 0.2, dominance: -0.15 },
    emotions: { fear: 0.3 }
  },
  anxious: {
    dimensions: { pleasure: -0.1, arousal: 0.15, dominance: -0.1, energy: -0.05 },
    emotions: { fear: 0.2 }
  },
  disgusted: {
    dimensions: { pleasure: -0.2, arousal: 0.1 },
    emotions: { disgust: 0.3 }
  },
  curious: {
    dimensions: { curiosity: 0.2, arousal: 0.1, pleasure: 0.05 },
    emotions: { surprise: 0.05 }
  },
  confused: {
    dimensions: { curiosity: 0.1, arousal: 0.1, dominance: -0.1 },
    emotions: { surprise: 0.1 }
  },
  focused: {
    dimensions: { curiosity: 0.1, arousal: 0.05, energy: 0.05, dominance: 0.05 },
    emotions: {}
  },
  surprised: {
    dimensions: { arousal: 0.2, curiosity: 0.1 },
    emotions: { surprise: 0.3 }
  },
  connected: {
    dimensions: { pleasure: 0.1, trust: 0.1, connection: 0.2 },
    emotions: { happiness: 0.1 }
  },
  trusting: {
    dimensions: { trust: 0.15, pleasure: 0.05, connection: 0.1 },
    emotions: { happiness: 0.05 }
  },
  lonely: {
    dimensions: { pleasure: -0.1, connection: -0.2 },
    emotions: { sadness: 0.15 }
  },
  fatigued: {
    dimensions: { energy: -0.25, arousal: -0.1, pleasure: -0.05 },
    emotions: { sadness: 0.05 }
  },
  neutral: {
    dimensions: {},
    emotions: {}
  }
};

const LABEL_ALIASES: Record<string, string> = {
  joy: "happy",
  happiness: "happy",
  contentment: "calm",
  content: "calm",
  peaceful: "calm",
  peace: "calm",
  anger: "angry",
  rage: "angry",
  irritated: "frustrated",
  irritation: "frustrated",
  sadness: "sad",
  sorrow: "sad",
  disappointment: "sad",
  disappointed: "sad",
  fear: "fearful",
  scared: "fearful",
  terrified: "fearful",
  anxiety: "anxious",
  worried: "anxious",
  worry: "anxious",
  disgust: "disgusted",
  revulsion: "disgusted",
  surprise: "surprised",
  shocked: "surprised",
  astonished: "surprised",
  curiosity: "curious",
  interest: "curious",
  interested: "curious",
  fascinated: "curious",
  confusion: "confused",
  bewildered: "confused",
  connection: "connected",
  warmth: "connected",
  warm: "connected",
  bonded: "connected",
  trust: "trusting",
  loneliness: "lonely",
  isolated: "lonely",
  fatigue: "fatigued",
  tired: "fatigued",
  exhausted: "fatigued",
  depleted: "fatigued",
  excitement: "excited",
  thrilled: "excited",
  relief: "relieved",
  optimism: "optimistic",
  hopeful: "optimistic",
  hope: "optimistic",
  energy: "energized",
  energetic: "energized",
  vigorous: "energized",
  focus: "focused",
  concentrated: "focused",
  attentive: "focused"
};

export function getEmotionMapping(label: string): EmotionDimensionDelta | undefined {
  const normalized = label.trim().toLowerCase();
  const canonical = LABEL_ALIASES[normalized] ?? normalized;
  return ALL_EMOTION_MAPPINGS[canonical];
}

export function normalizeEmotionLabel(label: string): string | null {
  const normalized = label.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const canonical = LABEL_ALIASES[normalized] ?? normalized;
  return ALL_EMOTION_MAPPINGS[canonical] ? canonical : null;
}

export function applyEmotionMapping(
  dimensions: EmotionalDimensions,
  emotions: EkmanEmotions,
  label: string,
  intensity: number
): { dimensions: EmotionalDimensions; emotions: EkmanEmotions } {
  const mapping = getEmotionMapping(label);
  if (!mapping) {
    return {
      dimensions: { ...dimensions },
      emotions: { ...emotions }
    };
  }

  const nextDimensions: EmotionalDimensions = { ...dimensions };
  for (const [dimension, delta] of Object.entries(mapping.dimensions)) {
    if (delta == null || !(dimension in nextDimensions)) {
      continue;
    }
    const name = dimension as keyof EmotionalDimensions;
    nextDimensions[name] = clampDimension(name, nextDimensions[name] + delta * intensity);
  }

  const nextEmotions: EkmanEmotions = { ...emotions };
  for (const [emotion, delta] of Object.entries(mapping.emotions)) {
    if (delta == null) {
      continue;
    }
    const name = emotion as keyof EkmanEmotions;
    nextEmotions[name] = clampEmotion(nextEmotions[name] + delta * intensity);
  }

  return {
    dimensions: nextDimensions,
    emotions: nextEmotions
  };
}
