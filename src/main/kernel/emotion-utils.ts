import type {
  AppConfig,
  EmotionalState,
  OCEANPersonality,
  RealtimeEmotionalSignals,
  RuminationEntry
} from "@shared/types";
import { DEFAULT_EMOTIONAL_STATE } from "@shared/types";
import {
  advanceRuminationQueue,
  applyEmotionMapping,
  applyGoalModulation,
  applyRuminationEffects,
  computeBaseline,
  computeDimensionDecayRates,
  computeEkmanDecayRates,
  computeResponseIntensityMultiplier,
  computeRuminationProbability,
  decayDimensions,
  decayEkman,
  inferGoals,
  normalizeEmotionLabel,
  shouldStartRumination
} from "./openfeelz";

const CONNECTION_HALF_LIFE_SECONDS = 48 * 3600;

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function clampRange(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function clampAbsDelta(value: number, maxAbs: number): number {
  return clampRange(value, -Math.abs(maxAbs), Math.abs(maxAbs));
}

export function applyElapsedEmotionalDecay(input: {
  emotional: EmotionalState;
  personality: OCEANPersonality;
  deltaSeconds: number;
}): EmotionalState {
  const elapsedHours = Math.max(0, input.deltaSeconds) / 3600;
  if (elapsedHours <= 0) {
    return input.emotional;
  }

  const baseline = computeBaseline(input.personality);
  const dimensionRates = computeDimensionDecayRates(input.personality);
  const ekmanRates = computeEkmanDecayRates(input.personality);

  const dimensions = decayDimensions(input.emotional.dimensions, baseline, dimensionRates, elapsedHours);
  const ekman = decayEkman(input.emotional.ekman, ekmanRates, elapsedHours);

  return {
    ...input.emotional,
    dimensions,
    ekman,
    connection: decayConnection(input.emotional.connection, input.deltaSeconds)
  };
}

function decayConnection(current: number, deltaSeconds: number): number {
  const safeDeltaSeconds = Math.max(0, deltaSeconds);
  if (safeDeltaSeconds <= 0) {
    return current;
  }

  const factor = Math.exp((-Math.log(2) * safeDeltaSeconds) / CONNECTION_HALF_LIFE_SECONDS);
  return clamp01(
    DEFAULT_EMOTIONAL_STATE.connection + (current - DEFAULT_EMOTIONAL_STATE.connection) * factor
  );
}

export function advanceEmotionalRumination(input: {
  emotional: EmotionalState;
  ruminationQueue: RuminationEntry[];
}): { emotional: EmotionalState; ruminationQueue: RuminationEntry[] } {
  if (input.ruminationQueue.length === 0) {
    return {
      emotional: input.emotional,
      ruminationQueue: input.ruminationQueue
    };
  }

  const applied = applyRuminationEffects(
    input.ruminationQueue,
    input.emotional.dimensions,
    input.emotional.ekman
  );

  return {
    emotional: {
      ...input.emotional,
      dimensions: applied.dimensions,
      ekman: applied.emotions
    },
    ruminationQueue: advanceRuminationQueue(input.ruminationQueue)
  };
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
  personality: OCEANPersonality;
  ruminationQueue: RuminationEntry[];
  signals: RealtimeEmotionalSignals;
  config: AppConfig["kernel"]["emotionSignals"];
  ageScale: number;
  now?: Date;
}): { emotional: EmotionalState; ruminationQueue: RuminationEntry[] } {
  const label = normalizeEmotionLabel(input.signals.emotion_label);
  if (!label) {
    return {
      emotional: input.emotional,
      ruminationQueue: input.ruminationQueue
    };
  }

  const nowIso = (input.now ?? new Date()).toISOString();
  const responseMultiplier = computeResponseIntensityMultiplier(input.personality);
  const goals = inferGoals(input.personality);
  const baseIntensity = clamp01(input.signals.intensity) * responseMultiplier;
  const goalIntensity = applyGoalModulation(goals, label, clamp01(baseIntensity));
  const mappingIntensity = clamp01(goalIntensity * input.config.deltaScale * input.ageScale);
  const scaledTrustDelta = clampAbsDelta(
    input.signals.trust_delta * input.config.deltaScale * input.ageScale,
    input.config.windowMaxAbsDelta
  );
  const scaledEnergyDelta = clampAbsDelta(
    (clamp01(input.signals.engagement) - 0.5) *
      input.config.energyEngagementScale *
      input.config.deltaScale *
      input.ageScale,
    input.config.windowMaxAbsDelta
  );

  const mapped = applyEmotionMapping(input.emotional.dimensions, input.emotional.ekman, label, mappingIntensity);
  const emotional: EmotionalState = {
    ...input.emotional,
    dimensions: {
      ...mapped.dimensions,
      energy: clamp01(mapped.dimensions.energy + scaledEnergyDelta),
      trust: clamp01(mapped.dimensions.trust + scaledTrustDelta)
    },
    ekman: mapped.emotions,
    connection: clamp01(input.emotional.connection + scaledTrustDelta * input.config.connectionTrustScale)
  };

  let ruminationQueue = input.ruminationQueue;
  const ruminationProbability = computeRuminationProbability(input.personality);
  if (
    shouldStartRumination(
      goalIntensity,
      input.config.ruminationThreshold,
      ruminationProbability
    )
  ) {
    ruminationQueue = [
      ...ruminationQueue,
      {
        label,
        intensity: goalIntensity,
        remainingStages: input.config.ruminationMaxStages,
        triggeredAt: nowIso
      }
    ];
  }

  return {
    emotional,
    ruminationQueue
  };
}

export function applyRealtimeEmotionalSignals(input: {
  emotional: EmotionalState;
  personality: OCEANPersonality;
  ruminationQueue: RuminationEntry[];
  signals: RealtimeEmotionalSignals | null | undefined;
  config: AppConfig["kernel"]["emotionSignals"];
  latestMessageTs?: string | null;
  now?: Date;
}): { emotional: EmotionalState; ruminationQueue: RuminationEntry[] } {
  if (!input.signals) {
    return {
      emotional: input.emotional,
      ruminationQueue: input.ruminationQueue
    };
  }

  const now = input.now ?? new Date();
  const ageScale = input.latestMessageTs
    ? computeSignalAgeScale(input.latestMessageTs, now, input.config)
    : 1;

  if (ageScale <= 0) {
    return {
      emotional: input.emotional,
      ruminationQueue: input.ruminationQueue
    };
  }

  return applyEmotionalSignalsToState({
    emotional: input.emotional,
    personality: input.personality,
    ruminationQueue: input.ruminationQueue,
    signals: input.signals,
    config: input.config,
    ageScale,
    now
  });
}
