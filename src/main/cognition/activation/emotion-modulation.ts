import type { EmotionConfig } from "@shared/cognition";
import { EmotionStateManager } from "../workspace/emotion-state";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeEmotionModulatedWeight(
  baseWeight: number,
  targetNodeValence: number,
  emotionState: EmotionStateManager,
  config: EmotionConfig
): number {
  if (config.modulation_strength === 0) {
    return baseWeight;
  }

  const matchScore = emotionState.computeMatchScore(targetNodeValence);
  const emotion = emotionState.getSnapshot();
  const arousalGain = config.valence_weight + config.arousal_weight * emotion.arousal;
  const modulation = clamp(config.modulation_strength * matchScore * arousalGain, -0.99, 1);
  return clamp(baseWeight * (1 + modulation), 0.01, 2);
}
