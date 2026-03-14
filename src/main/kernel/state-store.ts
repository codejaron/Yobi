import type { KernelStateDocument, OCEANPersonality, RelationshipStage, RuminationEntry } from "@shared/types";
import {
  DEFAULT_KERNEL_STATE,
  DEFAULT_OCEAN_PERSONALITY,
  createDefaultEmotionalState,
  getSessionWarmthBaseline
} from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import { readJsonFile, writeJsonFileAtomic } from "@main/storage/fs";

type Mutator = (current: KernelStateDocument) => KernelStateDocument | void;
type StateListener = (state: KernelStateDocument) => void;

export class StateStore {
  private loaded = false;
  private state: KernelStateDocument = cloneState(DEFAULT_KERNEL_STATE);
  private dirty = false;
  private readonly listeners = new Set<StateListener>();

  constructor(private readonly paths: CompanionPaths) {}

  async init(): Promise<void> {
    if (this.loaded) {
      return;
    }

    const raw = await readJsonFile<unknown>(this.paths.statePath, DEFAULT_KERNEL_STATE);
    this.state = normalizeState(raw);
    this.loaded = true;
    this.emit(this.getSnapshot());
  }

  getSnapshot(): KernelStateDocument {
    return cloneState(this.state);
  }

  subscribe(listener: StateListener, options?: { emitCurrent?: boolean }): () => void {
    this.listeners.add(listener);
    if (options?.emitCurrent) {
      listener(this.getSnapshot());
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  mutate(mutator: Mutator): KernelStateDocument {
    const draft = this.getSnapshot();
    const next = mutator(draft) ?? draft;
    this.state = normalizeState(next);
    this.state.updatedAt = new Date().toISOString();
    this.dirty = true;
    const snapshot = this.getSnapshot();
    this.emit(snapshot);
    return snapshot;
  }

  async flushIfDirty(): Promise<void> {
    if (!this.dirty) {
      return;
    }
    await this.flushInternal();
  }

  async forceFlush(): Promise<void> {
    await this.flushInternal();
  }

  private async flushInternal(): Promise<void> {
    await writeJsonFileAtomic(this.paths.statePath, toPersistedState(this.state));
    this.dirty = false;
  }

  private emit(snapshot: KernelStateDocument): void {
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneState(state: KernelStateDocument): KernelStateDocument {
  return {
    emotional: {
      dimensions: {
        ...state.emotional.dimensions
      },
      ekman: {
        ...state.emotional.ekman
      },
      connection: state.emotional.connection,
      sessionWarmth: state.emotional.sessionWarmth
    },
    personality: {
      ...state.personality
    },
    ruminationQueue: state.ruminationQueue.map((entry) => ({ ...entry })),
    relationship: {
      ...state.relationship
    },
    lastDecayAt: state.lastDecayAt,
    lastDailyTaskDayKey: state.lastDailyTaskDayKey ?? null,
    sessionReentry: state.sessionReentry ? { ...state.sessionReentry } : null,
    updatedAt: state.updatedAt
  };
}

function normalizeRelationshipStage(value: unknown): RelationshipStage {
  return value === "stranger" ||
    value === "acquaintance" ||
    value === "familiar" ||
    value === "close" ||
    value === "intimate"
    ? value
    : DEFAULT_KERNEL_STATE.relationship.stage;
}

function isLegacyEmotionalShape(value: unknown): boolean {
  return isRecord(value) && (
    "mood" in value ||
    "confidence" in value ||
    "irritation" in value ||
    ("energy" in value && !("dimensions" in value))
  );
}

function normalizePersonality(value: unknown): OCEANPersonality {
  const source = isRecord(value) ? value : {};
  return {
    openness: clamp01(toNumber(source.openness, DEFAULT_OCEAN_PERSONALITY.openness)),
    conscientiousness: clamp01(
      toNumber(source.conscientiousness, DEFAULT_OCEAN_PERSONALITY.conscientiousness)
    ),
    extraversion: clamp01(toNumber(source.extraversion, DEFAULT_OCEAN_PERSONALITY.extraversion)),
    agreeableness: clamp01(toNumber(source.agreeableness, DEFAULT_OCEAN_PERSONALITY.agreeableness)),
    neuroticism: clamp01(toNumber(source.neuroticism, DEFAULT_OCEAN_PERSONALITY.neuroticism))
  };
}

function normalizeRuminationQueue(value: unknown): RuminationEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    if (!label) {
      return [];
    }

    const triggeredAt =
      typeof entry.triggeredAt === "string" && Number.isFinite(new Date(entry.triggeredAt).getTime())
        ? new Date(entry.triggeredAt).toISOString()
        : new Date().toISOString();

    return [
      {
        label,
        intensity: clamp01(toNumber(entry.intensity, 0)),
        remainingStages: Math.max(0, Math.floor(toNumber(entry.remainingStages, 0))),
        triggeredAt
      }
    ].filter((normalized) => normalized.remainingStages > 0 && normalized.intensity >= 0.05);
  });
}

function normalizeEmotionalState(value: unknown, stage: RelationshipStage): KernelStateDocument["emotional"] {
  if (isLegacyEmotionalShape(value)) {
    return createDefaultEmotionalState(stage);
  }

  if (!isRecord(value)) {
    return createDefaultEmotionalState(stage);
  }

  const defaults = createDefaultEmotionalState(stage);
  const dimensions = isRecord(value.dimensions) ? value.dimensions : {};
  const ekman = isRecord(value.ekman) ? value.ekman : {};

  return {
    dimensions: {
      pleasure: clamp(toNumber(dimensions.pleasure, defaults.dimensions.pleasure), -1, 1),
      arousal: clamp(toNumber(dimensions.arousal, defaults.dimensions.arousal), -1, 1),
      dominance: clamp(toNumber(dimensions.dominance, defaults.dimensions.dominance), -1, 1),
      curiosity: clamp01(toNumber(dimensions.curiosity, defaults.dimensions.curiosity)),
      energy: clamp01(toNumber(dimensions.energy, defaults.dimensions.energy)),
      trust: clamp01(toNumber(dimensions.trust, defaults.dimensions.trust))
    },
    ekman: {
      happiness: clamp01(toNumber(ekman.happiness, defaults.ekman.happiness)),
      sadness: clamp01(toNumber(ekman.sadness, defaults.ekman.sadness)),
      anger: clamp01(toNumber(ekman.anger, defaults.ekman.anger)),
      fear: clamp01(toNumber(ekman.fear, defaults.ekman.fear)),
      disgust: clamp01(toNumber(ekman.disgust, defaults.ekman.disgust)),
      surprise: clamp01(toNumber(ekman.surprise, defaults.ekman.surprise))
    },
    connection: clamp01(toNumber(value.connection, defaults.connection)),
    sessionWarmth: clamp(
      toNumber(value.sessionWarmth, getSessionWarmthBaseline(stage)),
      getSessionWarmthBaseline(stage),
      1
    )
  };
}

function normalizeState(input: unknown): KernelStateDocument {
  const raw = isRecord(input) ? input : {};
  const relationshipRaw = isRecord(raw.relationship) ? raw.relationship : {};
  const stage = normalizeRelationshipStage(relationshipRaw.stage);
  const emotional = normalizeEmotionalState(raw.emotional, stage);

  return {
    emotional,
    personality: normalizePersonality(raw.personality),
    ruminationQueue: normalizeRuminationQueue(raw.ruminationQueue),
    relationship: {
      stage,
      upgradeStreak: Math.max(0, Math.floor(toNumber(relationshipRaw.upgradeStreak, 0))),
      downgradeStreak: Math.max(0, Math.floor(toNumber(relationshipRaw.downgradeStreak, 0)))
    },
    lastDecayAt:
      typeof raw.lastDecayAt === "string" && Number.isFinite(new Date(raw.lastDecayAt).getTime())
        ? new Date(raw.lastDecayAt).toISOString()
        : null,
    lastDailyTaskDayKey:
      typeof raw.lastDailyTaskDayKey === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.lastDailyTaskDayKey)
        ? raw.lastDailyTaskDayKey
        : null,
    sessionReentry: isRecord(raw.sessionReentry)
      ? {
          active: Boolean(raw.sessionReentry.active),
          gapHours: Math.max(0, Math.floor(toNumber(raw.sessionReentry.gapHours, 0))),
          gapLabel: typeof raw.sessionReentry.gapLabel === "string" ? raw.sessionReentry.gapLabel : "",
          activatedAt:
            typeof raw.sessionReentry.activatedAt === "string" &&
            Number.isFinite(new Date(raw.sessionReentry.activatedAt).getTime())
              ? new Date(raw.sessionReentry.activatedAt).toISOString()
              : new Date().toISOString()
        }
      : null,
    updatedAt:
      typeof raw.updatedAt === "string" && Number.isFinite(new Date(raw.updatedAt).getTime())
        ? new Date(raw.updatedAt).toISOString()
        : new Date().toISOString()
  };
}

function toPersistedState(state: KernelStateDocument): Record<string, unknown> {
  return {
    emotional: {
      dimensions: {
        ...state.emotional.dimensions
      },
      ekman: {
        ...state.emotional.ekman
      },
      connection: state.emotional.connection
    },
    personality: {
      ...state.personality
    },
    ruminationQueue: state.ruminationQueue.map((entry) => ({ ...entry })),
    relationship: {
      ...state.relationship
    },
    lastDecayAt: state.lastDecayAt,
    lastDailyTaskDayKey: state.lastDailyTaskDayKey ?? null,
    sessionReentry: state.sessionReentry ? { ...state.sessionReentry } : null,
    updatedAt: state.updatedAt
  };
}
