import type { EmotionalState } from "@shared/types";

function flattenEmotion(state: EmotionalState): number[] {
  return [
    state.dimensions.pleasure,
    state.dimensions.arousal,
    state.dimensions.dominance,
    state.dimensions.curiosity,
    state.dimensions.energy,
    state.dimensions.trust,
    state.ekman.happiness,
    state.ekman.sadness,
    state.ekman.anger,
    state.ekman.fear,
    state.ekman.disgust,
    state.ekman.surprise,
    state.connection,
    state.sessionWarmth
  ];
}

export function hasEmotionalDeltaAtLeast(
  previous: EmotionalState | null | undefined,
  next: EmotionalState,
  epsilon: number
): boolean {
  if (!previous) {
    return true;
  }

  const previousValues = flattenEmotion(previous);
  const nextValues = flattenEmotion(next);
  return previousValues.some((value, index) => Math.abs(nextValues[index] - value) >= epsilon);
}

export function shouldPublishEmotionState(input: {
  previous: EmotionalState | null | undefined;
  next: EmotionalState;
  epsilon: number;
  heartbeatMs: number;
  nowMs: number;
  lastPublishedAtMs: number;
  force?: boolean;
}): boolean {
  if (input.force) {
    return true;
  }

  if (hasEmotionalDeltaAtLeast(input.previous, input.next, input.epsilon)) {
    return true;
  }

  if (input.lastPublishedAtMs <= 0) {
    return true;
  }

  return input.nowMs - input.lastPublishedAtMs >= input.heartbeatMs;
}
