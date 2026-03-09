import type { KernelStateDocument } from "@shared/types";
import { DEFAULT_KERNEL_STATE } from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import { readJsonFile, writeJsonFileAtomic } from "@main/storage/fs";

type Mutator = (current: KernelStateDocument) => KernelStateDocument | void;
type StateListener = (state: KernelStateDocument) => void;

export class StateStore {
  private loaded = false;
  private state: KernelStateDocument = {
    ...DEFAULT_KERNEL_STATE
  };
  private dirty = false;
  private readonly listeners = new Set<StateListener>();

  constructor(private readonly paths: CompanionPaths) {}

  async init(): Promise<void> {
    if (this.loaded) {
      return;
    }

    const raw = await readJsonFile<KernelStateDocument>(this.paths.statePath, DEFAULT_KERNEL_STATE);
    this.state = normalizeState(raw);
    this.loaded = true;
    this.emit(this.getSnapshot());
  }

  getSnapshot(): KernelStateDocument {
    return {
      ...this.state,
      emotional: {
        ...this.state.emotional
      },
      relationship: {
        ...this.state.relationship
      },
      sessionReentry: this.state.sessionReentry ? { ...this.state.sessionReentry } : null,
      lastDecayAt: this.state.lastDecayAt
    };
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
    await writeJsonFileAtomic(this.paths.statePath, this.state);
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

function toNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return value;
}

function normalizeState(input: KernelStateDocument): KernelStateDocument {
  const stage = input.relationship?.stage;
  return {
    emotional: {
      mood: clamp(toNumber(input.emotional?.mood, DEFAULT_KERNEL_STATE.emotional.mood), -1, 1),
      energy: clamp(toNumber(input.emotional?.energy, DEFAULT_KERNEL_STATE.emotional.energy), 0, 1),
      connection: clamp(
        toNumber(input.emotional?.connection, DEFAULT_KERNEL_STATE.emotional.connection),
        0,
        1
      ),
      curiosity: clamp(
        toNumber(input.emotional?.curiosity, DEFAULT_KERNEL_STATE.emotional.curiosity),
        0,
        1
      ),
      confidence: clamp(
        toNumber(input.emotional?.confidence, DEFAULT_KERNEL_STATE.emotional.confidence),
        0,
        1
      ),
      irritation: clamp(
        toNumber(input.emotional?.irritation, DEFAULT_KERNEL_STATE.emotional.irritation),
        0,
        1
      )
    },
    relationship: {
      stage:
        stage === "stranger" ||
        stage === "acquaintance" ||
        stage === "familiar" ||
        stage === "close" ||
        stage === "intimate"
          ? stage
          : DEFAULT_KERNEL_STATE.relationship.stage,
      upgradeStreak: Math.max(0, Math.floor(toNumber(input.relationship?.upgradeStreak, 0))),
      downgradeStreak: Math.max(0, Math.floor(toNumber(input.relationship?.downgradeStreak, 0)))
    },
    coldStart: typeof input.coldStart === "boolean" ? input.coldStart : DEFAULT_KERNEL_STATE.coldStart,
    lastDecayAt:
      typeof input.lastDecayAt === "string" && Number.isFinite(new Date(input.lastDecayAt).getTime())
        ? new Date(input.lastDecayAt).toISOString()
        : null,
    sessionReentry: input.sessionReentry
      ? {
          active: Boolean(input.sessionReentry.active),
          gapHours: Math.max(0, Math.floor(toNumber(input.sessionReentry.gapHours, 0))),
          gapLabel:
            typeof input.sessionReentry.gapLabel === "string" ? input.sessionReentry.gapLabel : "",
          activatedAt:
            typeof input.sessionReentry.activatedAt === "string"
              ? input.sessionReentry.activatedAt
              : new Date().toISOString()
        }
      : null,
    updatedAt:
      typeof input.updatedAt === "string" && Number.isFinite(new Date(input.updatedAt).getTime())
        ? new Date(input.updatedAt).toISOString()
        : new Date().toISOString()
  };
}
