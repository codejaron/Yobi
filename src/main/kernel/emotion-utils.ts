import { DEFAULT_EMOTIONAL_STATE, type AppConfig, type EmotionalState } from "@shared/types";
import type { EmotionalSignals } from "@main/memory-v2/extraction-runner";

const EMOTIONAL_HALF_LIFE_SECONDS = {
  mood: 12 * 3600,
  energy: 8 * 3600,
  connection: 72 * 3600,
  curiosity: 24 * 3600,
  confidence: 48 * 3600,
  irritation: 4 * 3600
} as const;

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function clampRange(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function clampAbsDelta(value: number, maxAbs: number): number {
  return clampRange(value, -Math.abs(maxAbs), Math.abs(maxAbs));
}

export function computeMessageCadenceScale(gapMs: number | null): number {
  if (gapMs === null) {
    return 1;
  }
  const minGapMs = 2 * 60_000;
  const maxGapMs = 10 * 60_000;
  if (gapMs <= minGapMs) {
    return 0.3;
  }
  if (gapMs >= maxGapMs) {
    return 1;
  }
  const ratio = (gapMs - minGapMs) / Math.max(1, maxGapMs - minGapMs);
  return clampRange(0.3 + ratio * 0.7, 0.3, 1);
}

export function applyElapsedEmotionalDecay(emotional: EmotionalState, deltaSeconds: number): EmotionalState {
  const safeDeltaSeconds = Math.max(0, deltaSeconds);
  const decayToward = (value: number, baseline: number, halfLifeSeconds: number, min: number, max: number) => {
    const factor = Math.exp((-Math.log(2) * safeDeltaSeconds) / Math.max(1, halfLifeSeconds));
    return clampRange(baseline + (value - baseline) * factor, min, max);
  };

  return {
    mood: decayToward(emotional.mood, DEFAULT_EMOTIONAL_STATE.mood, EMOTIONAL_HALF_LIFE_SECONDS.mood, -1, 1),
    energy: decayToward(emotional.energy, DEFAULT_EMOTIONAL_STATE.energy, EMOTIONAL_HALF_LIFE_SECONDS.energy, 0, 1),
    connection: decayToward(emotional.connection, DEFAULT_EMOTIONAL_STATE.connection, EMOTIONAL_HALF_LIFE_SECONDS.connection, 0, 1),
    curiosity: decayToward(emotional.curiosity, DEFAULT_EMOTIONAL_STATE.curiosity, EMOTIONAL_HALF_LIFE_SECONDS.curiosity, 0, 1),
    confidence: decayToward(emotional.confidence, DEFAULT_EMOTIONAL_STATE.confidence, EMOTIONAL_HALF_LIFE_SECONDS.confidence, 0, 1),
    irritation: decayToward(emotional.irritation, DEFAULT_EMOTIONAL_STATE.irritation, EMOTIONAL_HALF_LIFE_SECONDS.irritation, 0, 1)
  };
}

export function applyRealtimeEmotionHeuristics(
  emotional: EmotionalState,
  text: string,
  config: AppConfig["kernel"]["emotionSignals"]
): EmotionalState {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return emotional;
  }

  const next: EmotionalState = { ...emotional };
  const positiveTerms = ["开心", "高兴", "快乐", "期待", "喜欢", "兴奋"];
  const negativeTerms = ["累", "疲惫", "难过", "烦", "焦虑", "崩溃", "无语", "压力", "加班", "困"];
  const curiosityTerms = ["想知道", "为什么", "好奇", "想试试", "感兴趣"];
  const frictionTerms = ["烦死了", "气死", "破防", "无语", "烦"];

  const positiveHit = positiveTerms.some((term) => normalized.includes(term));
  const negativeHit = negativeTerms.some((term) => normalized.includes(term));
  const curiosityHit = curiosityTerms.some((term) => normalized.includes(term));
  const frictionHit = frictionTerms.some((term) => normalized.includes(term));

  const moodStep = Math.max(config.moodPositiveStep, config.moodNegativeStep) * 0.25;
  const connectionStep = config.minPositiveTrustDelta * 0.25;
  const curiosityStep = config.curiosityBoost * 0.25;
  const irritationStep = config.irritationBoostOnFriction * 0.25;

  if (positiveHit) {
    next.mood = clampRange(next.mood + moodStep, -1, 1);
    next.connection = clamp01(next.connection + connectionStep);
  }
  if (negativeHit) {
    next.mood = clampRange(next.mood - moodStep, -1, 1);
    next.energy = clamp01(next.energy - config.energyEngagementScale * 0.25);
  }
  if (curiosityHit) {
    next.curiosity = clamp01(next.curiosity + curiosityStep);
  }
  if (frictionHit) {
    next.irritation = clamp01(next.irritation + irritationStep);
    next.confidence = clamp01(next.confidence - config.confidenceDropOnFriction * 0.25);
  }

  return next;
}

export function computeSignalAgeScale(
  latestMessageTs: string,
  now: Date,
  config: AppConfig["kernel"]["emotionSignals"]
): number {
  const latestTs = Number.isFinite(new Date(latestMessageTs).getTime())
    ? new Date(latestMessageTs).getTime()
    : now.getTime();
  const ageMinutes = Math.max(0, (now.getTime() - latestTs) / 60_000);
  const fullEffect = config.stalenessFullEffectMinutes;
  const maxAgeMinutes = config.stalenessMaxAgeHours * 60;

  if (ageMinutes <= fullEffect) {
    return 1;
  }
  if (ageMinutes >= maxAgeMinutes) {
    return 0;
  }
  const ratio = (ageMinutes - fullEffect) / Math.max(1, maxAgeMinutes - fullEffect);
  const scaled = 1 - ratio * (1 - config.stalenessMinScale);
  return clampRange(scaled, config.stalenessMinScale, 1);
}

export function applyEmotionalSignalsToState(input: {
  emotional: EmotionalState;
  signals: EmotionalSignals;
  config: AppConfig["kernel"]["emotionSignals"];
  ageScale: number;
}): EmotionalState {
  const scaledDelta = (raw: number): number =>
    clampAbsDelta(raw * input.ageScale, input.config.windowMaxAbsDelta);
  const next: EmotionalState = {
    ...input.emotional
  };

  const moodDelta =
    input.signals.user_mood === "positive"
      ? input.config.moodPositiveStep
      : input.signals.user_mood === "negative"
        ? -input.config.moodNegativeStep
        : input.signals.user_mood === "mixed"
          ? -input.config.moodNegativeStep * 0.35
          : 0;
  next.mood = clampRange(next.mood + scaledDelta(moodDelta), -1, 1);

  const energyDelta = (input.signals.engagement - 0.5) * input.config.energyEngagementScale;
  next.energy = clamp01(next.energy + scaledDelta(energyDelta));

  next.connection = clamp01(next.connection + scaledDelta(input.signals.trust_delta));

  const curiosityDelta = input.signals.curiosity_trigger ? input.config.curiosityBoost : 0;
  next.curiosity = clamp01(next.curiosity + scaledDelta(curiosityDelta));

  let confidenceDelta = 0;
  if (!input.signals.friction && input.signals.engagement >= input.config.minPositiveEngagement) {
    confidenceDelta += input.config.confidenceGain;
  }
  if (input.signals.friction) {
    confidenceDelta -= input.config.confidenceDropOnFriction;
  }
  next.confidence = clamp01(next.confidence + scaledDelta(confidenceDelta));

  const irritationDelta = input.signals.friction ? input.config.irritationBoostOnFriction : 0;
  next.irritation = clamp01(next.irritation + scaledDelta(irritationDelta));

  return next;
}
