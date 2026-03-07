import { randomUUID } from "node:crypto";
import type { PendingTask, PendingTaskType } from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import { readJsonlFile, writeJsonlFileAtomic } from "@main/storage/fs";

export type TaskHandler = (task: PendingTask) => Promise<void>;

const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 2_000;
const DRAIN_POLL_INTERVAL_MS = 25;
const TRANSIENT_BACKOFF_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class KernelTaskQueue {
  private loaded = false;
  private tasks: PendingTask[] = [];
  private deadLetters: PendingTask[] = [];
  private handlers = new Map<PendingTaskType, TaskHandler>();
  private runningIds = new Set<string>();
  private persistChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly paths: CompanionPaths,
    private readonly maxConcurrent = 1,
    private readonly retryLimit = 2
  ) {}

  async init(): Promise<void> {
    if (this.loaded) {
      return;
    }
    const [rows, deadLetterRows] = await Promise.all([
      readJsonlFile<PendingTask>(this.paths.pendingTasksPath),
      readJsonlFile<PendingTask>(this.paths.deadLetterTasksPath)
    ]);
    this.tasks = rows
      .map((task) => normalizeTask(task))
      .filter((task): task is PendingTask => task !== null);
    this.deadLetters = deadLetterRows
      .map((task) => normalizeTask(task))
      .filter((task): task is PendingTask => task !== null);
    this.loaded = true;
  }

  register(type: PendingTaskType, handler: TaskHandler): void {
    this.handlers.set(type, handler);
  }

  list(): PendingTask[] {
    return this.tasks.map((task) => ({ ...task }));
  }

  depth(): number {
    return this.tasks.filter((task) => task.status === "pending" || task.status === "running").length;
  }

  hasCompletedRange(type: PendingTaskType, sourceRange: string): boolean {
    return this.tasks.some(
      (task) => task.type === type && task.source_range === sourceRange && task.status === "completed"
    );
  }

  async enqueue(input: {
    type: PendingTaskType;
    payload: Record<string, unknown>;
    sourceRange?: string;
  }): Promise<PendingTask> {
    await this.init();
    const next = this.createTaskIfNeeded(input);
    await this.persist();
    return { ...next };
  }

  async enqueueMany(inputs: Array<{
    type: PendingTaskType;
    payload: Record<string, unknown>;
    sourceRange?: string;
  }>): Promise<PendingTask[]> {
    await this.init();
    if (inputs.length === 0) {
      return [];
    }
    const created = inputs.map((input) => this.createTaskIfNeeded(input));
    await this.persist();
    return created.map((task) => ({ ...task }));
  }

  async processAvailable(): Promise<void> {
    await this.init();
    const now = Date.now();
    while (this.runningIds.size < this.maxConcurrent) {
      const next = this.tasks.find((task) => {
        if (task.status !== "pending") {
          return false;
        }
        const availableAt = new Date(task.available_at).getTime();
        return !Number.isFinite(availableAt) || availableAt <= now;
      });
      if (!next) {
        break;
      }
      void this.runTask(next);
    }
  }

  async drainUntilIdle(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.processAvailable();
      const now = Date.now();
      const hasDuePending = this.tasks.some((task) => {
        if (task.status !== "pending") {
          return false;
        }
        const availableAt = new Date(task.available_at).getTime();
        return !Number.isFinite(availableAt) || availableAt <= now;
      });
      if (this.runningIds.size === 0 && !hasDuePending) {
        return;
      }
      await sleep(DRAIN_POLL_INTERVAL_MS);
    }
  }

  async compactCompleted(): Promise<void> {
    await this.init();
    this.tasks = this.tasks.filter((task) => task.status !== "completed");
    await this.persist();
  }

  private async runTask(task: PendingTask): Promise<void> {
    const handler = this.handlers.get(task.type);
    if (!handler) {
      return;
    }
    if (this.runningIds.has(task.id)) {
      return;
    }

    this.runningIds.add(task.id);
    task.status = "running";
    task.updated_at = new Date().toISOString();
    await this.persist();

    try {
      await handler({ ...task });
      task.status = "completed";
      task.updated_at = new Date().toISOString();
      task.last_error = undefined;
      task.available_at = task.updated_at;
    } catch (error) {
      task.updated_at = new Date().toISOString();
      task.last_error = error instanceof Error ? error.message : "unknown";

      if (isTransientTaskError(error)) {
        task.status = "pending";
        task.available_at = new Date(Date.now() + TRANSIENT_BACKOFF_MS).toISOString();
      } else {
        task.attempts += 1;
        if (task.attempts > this.retryLimit) {
          task.status = "failed";
          task.available_at = task.updated_at;
          this.deadLetters.push({ ...task });
          this.tasks = this.tasks.filter((candidate) => candidate.id !== task.id);
        } else {
          task.status = "pending";
          const backoffMs = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, task.attempts - 1));
          task.available_at = new Date(Date.now() + backoffMs).toISOString();
        }
      }
    } finally {
      this.runningIds.delete(task.id);
      await this.persist();
      if (this.runningIds.size < this.maxConcurrent) {
        void this.processAvailable();
      }
    }
  }

  private async persist(): Promise<void> {
    const snapshot = this.tasks.map((task) => ({
      ...task,
      payload: {
        ...task.payload
      }
    }));
    const deadLetterSnapshot = this.deadLetters.map((task) => ({
      ...task,
      payload: {
        ...task.payload
      }
    }));

    const writeTask = async () => {
      await writeJsonlFileAtomic(this.paths.pendingTasksPath, snapshot);
      await writeJsonlFileAtomic(this.paths.deadLetterTasksPath, deadLetterSnapshot);
    };

    const next = this.persistChain.catch(() => undefined).then(writeTask);
    this.persistChain = next;
    await next;
  }

  private createTaskIfNeeded(input: {
    type: PendingTaskType;
    payload: Record<string, unknown>;
    sourceRange?: string;
  }): PendingTask {
    if (input.sourceRange) {
      const existing = this.tasks.find(
        (task) =>
          task.type === input.type &&
          task.source_range === input.sourceRange &&
          (task.status === "pending" || task.status === "running" || task.status === "completed")
      );
      if (existing) {
        return existing;
      }
    }

    const now = new Date().toISOString();
    const next: PendingTask = {
      id: randomUUID(),
      type: input.type,
      status: "pending",
      payload: input.payload,
      source_range: input.sourceRange,
      available_at: now,
      attempts: 0,
      created_at: now,
      updated_at: now
    };
    this.tasks.push(next);
    return next;
  }
}

function isTransientTaskError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message === "background-worker-unavailable" || error.message === "worker-unavailable";
}

function normalizeTask(raw: PendingTask): PendingTask | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  if (
    raw.type !== "fact-extraction" &&
    raw.type !== "profile-semantic-update" &&
    raw.type !== "daily-episode" &&
    raw.type !== "daily-reflection"
  ) {
    return null;
  }

  if (
    raw.status !== "pending" &&
    raw.status !== "running" &&
    raw.status !== "completed" &&
    raw.status !== "failed"
  ) {
    return null;
  }

  const now = new Date().toISOString();
  return {
    id: typeof raw.id === "string" ? raw.id : randomUUID(),
    type: raw.type,
    status: raw.status,
    payload: raw.payload && typeof raw.payload === "object" ? raw.payload : {},
    source_range: typeof raw.source_range === "string" ? raw.source_range : undefined,
    available_at:
      typeof raw.available_at === "string" && Number.isFinite(new Date(raw.available_at).getTime())
        ? new Date(raw.available_at).toISOString()
        : now,
    attempts: Number.isFinite(raw.attempts) ? Math.max(0, Math.floor(raw.attempts)) : 0,
    created_at:
      typeof raw.created_at === "string" && Number.isFinite(new Date(raw.created_at).getTime())
        ? new Date(raw.created_at).toISOString()
        : now,
    updated_at:
      typeof raw.updated_at === "string" && Number.isFinite(new Date(raw.updated_at).getTime())
        ? new Date(raw.updated_at).toISOString()
        : now,
    last_error: typeof raw.last_error === "string" ? raw.last_error : undefined
  };
}
