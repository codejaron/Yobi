/*
 * Adapted from OpenFeelz (https://github.com/trianglegrrl/openfeelz), MIT License.
 * Source basis: src/model/personality.ts from OpenFeelz v1.1.1.
 */

import type { EkmanEmotions, EmotionalDimensions, OCEANPersonality } from "@shared/types";
import { DEFAULT_OCEAN_PERSONALITY } from "@shared/types";
import { clampDimension, type DimensionName } from "./emotion-model";

export type DimensionDecayRates = Record<DimensionName, number>;
export type EkmanDecayRates = Record<keyof EkmanEmotions, number>;

const TRAIT_BASELINE_INFLUENCE: Record<keyof OCEANPersonality, Partial<Record<DimensionName, number>>> = {
  openness: { curiosity: 0.3, dominance: 0.1 },
  conscientiousness: { energy: 0.2, dominance: 0.15 },
  extraversion: { pleasure: 0.25, arousal: 0.2 },
  agreeableness: { trust: 0.2, pleasure: 0.1 },
  neuroticism: { pleasure: -0.25, arousal: 0.15, energy: -0.1 }
};

const TRAIT_DIMENSION_DECAY_INFLUENCE: Record<keyof OCEANPersonality, Partial<Record<DimensionName, number>>> = {
  openness: { curiosity: -0.3 },
  conscientiousness: { energy: 0.2 },
  extraversion: { arousal: 0.3, pleasure: 0.2 },
  agreeableness: { trust: -0.1 },
  neuroticism: { pleasure: -0.4, arousal: -0.2 }
};

const TRAIT_EMOTION_DECAY_INFLUENCE: Record<
  keyof OCEANPersonality,
  Partial<Record<keyof EkmanEmotions, number>>
> = {
  openness: { surprise: -0.3, happiness: -0.1 },
  conscientiousness: {},
  extraversion: { sadness: 0.4, happiness: -0.2 },
  agreeableness: { anger: 0.3 },
  neuroticism: { sadness: -0.4, anger: -0.3, fear: -0.3, disgust: -0.2 }
};

const BASE_DIMENSION_DECAY_RATES: DimensionDecayRates = {
  pleasure: 0.058,
  arousal: 0.087,
  dominance: 0.046,
  curiosity: 0.058,
  energy: 0.046,
  trust: 0.035
};

const BASE_EKMAN_DECAY_RATES: EkmanDecayRates = {
  happiness: 0.058,
  sadness: 0.046,
  anger: 0.058,
  fear: 0.058,
  disgust: 0.046,
  surprise: 0.139
};

export function createDefaultPersonality(): OCEANPersonality {
  return {
    ...DEFAULT_OCEAN_PERSONALITY
  };
}

export function computeBaseline(personality: OCEANPersonality): EmotionalDimensions {
  const baseline: EmotionalDimensions = {
    pleasure: 0,
    arousal: 0,
    dominance: 0,
    curiosity: 0.5,
    energy: 0.5,
    trust: 0.5
  };

  for (const [trait, influences] of Object.entries(TRAIT_BASELINE_INFLUENCE) as Array<
    [keyof OCEANPersonality, Partial<Record<DimensionName, number>>]
  >) {
    const deviation = personality[trait] - 0.5;
    for (const [dimension, weight] of Object.entries(influences) as Array<[DimensionName, number]>) {
      baseline[dimension] += weight * deviation;
    }
  }

  return {
    pleasure: clampDimension("pleasure", baseline.pleasure),
    arousal: clampDimension("arousal", baseline.arousal),
    dominance: clampDimension("dominance", baseline.dominance),
    curiosity: clampDimension("curiosity", baseline.curiosity),
    energy: clampDimension("energy", baseline.energy),
    trust: clampDimension("trust", baseline.trust)
  };
}

export function computeDimensionDecayRates(personality: OCEANPersonality): DimensionDecayRates {
  const rates: DimensionDecayRates = { ...BASE_DIMENSION_DECAY_RATES };

  for (const [trait, influences] of Object.entries(TRAIT_DIMENSION_DECAY_INFLUENCE) as Array<
    [keyof OCEANPersonality, Partial<Record<DimensionName, number>>]
  >) {
    const deviation = personality[trait] - 0.5;
    for (const [dimension, weight] of Object.entries(influences) as Array<[DimensionName, number]>) {
      rates[dimension] *= Math.max(0.1, 1 + weight * deviation);
    }
  }

  return rates;
}

export function computeEkmanDecayRates(personality: OCEANPersonality): EkmanDecayRates {
  const rates: EkmanDecayRates = { ...BASE_EKMAN_DECAY_RATES };

  for (const [trait, influences] of Object.entries(TRAIT_EMOTION_DECAY_INFLUENCE) as Array<
    [keyof OCEANPersonality, Partial<Record<keyof EkmanEmotions, number>>]
  >) {
    const deviation = personality[trait] - 0.5;
    for (const [emotion, weight] of Object.entries(influences) as Array<[keyof EkmanEmotions, number]>) {
      rates[emotion] *= Math.max(0.1, 1 + weight * deviation);
    }
  }

  return rates;
}

export function computeRuminationProbability(personality: OCEANPersonality): number {
  const base = 0.5;
  const neuroticismEffect = (personality.neuroticism - 0.5) * 0.6;
  const opennessEffect = (personality.openness - 0.5) * 0.2;
  const conscientiousnessEffect = (personality.conscientiousness - 0.5) * -0.3;
  return Math.max(0, Math.min(1, base + neuroticismEffect + opennessEffect + conscientiousnessEffect));
}

export function computeResponseIntensityMultiplier(personality: OCEANPersonality): number {
  const base = 1;
  const neuroticismEffect = (personality.neuroticism - 0.5) * 0.4;
  const agreeablenessEffect = (personality.agreeableness - 0.5) * -0.2;
  return Math.max(0.5, Math.min(2, base + neuroticismEffect + agreeablenessEffect));
}

export const DEFAULT_EKMAN_DECAY_RATES: EkmanDecayRates = { ...BASE_EKMAN_DECAY_RATES };
export const DEFAULT_DIMENSION_DECAY_RATES: DimensionDecayRates = { ...BASE_DIMENSION_DECAY_RATES };
