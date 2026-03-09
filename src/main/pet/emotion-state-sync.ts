import type { EmotionalState } from "@shared/types";

const EMOTION_KEYS: Array<keyof EmotionalState> = [
  "mood",
  "energy",
  "connection",
  "curiosity",
  "confidence",
  "irritation"
];

export function hasEmotionalDeltaAtLeast(
  previous: EmotionalState | null | undefined,
  next: EmotionalState,
  epsilon: number
): boolean {
  if (!previous) {
    return true;
  }

  return EMOTION_KEYS.some((key) => Math.abs(next[key] - previous[key]) >= epsilon);
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
