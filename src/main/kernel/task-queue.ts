import { randomUUID } from "node:crypto";
import type { PendingTask, PendingTaskType } from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import { readJsonlFile, writeJsonlFileAtomic } from "@main/storage/fs";

export type TaskHandler = (task: PendingTask) => Promise<void>;

export class KernelTaskQueue {
  private loaded = false;
  private tasks: PendingTask[] = [];
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
    const rows = await readJsonlFile<PendingTask>(this.paths.pendingTasksPath);
    this.tasks = rows
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
    if (
      input.sourceRange &&
      this.tasks.some(
        (task) =>
          task.type === input.type &&
          task.source_range === input.sourceRange &&
          (task.status === "pending" || task.status === "running" || task.status === "completed")
      )
    ) {
      const existing = this.tasks.find(
        (task) =>
          task.type === input.type &&
          task.source_range === input.sourceRange &&
          (task.status === "pending" || task.status === "running" || task.status === "completed")
      );
      if (existing) {
        return { ...existing };
      }
    }

    const now = new Date().toISOString();
    const next: PendingTask = {
      id: randomUUID(),
      type: input.type,
      status: "pending",
      payload: input.payload,
      source_range: input.sourceRange,
      attempts: 0,
      created_at: now,
      updated_at: now
    };
    this.tasks.push(next);
    await this.persist();
    return { ...next };
  }

  async processAvailable(): Promise<void> {
    await this.init();
    while (this.runningIds.size < this.maxConcurrent) {
      const next = this.tasks.find((task) => task.status === "pending");
      if (!next) {
        break;
      }
      void this.runTask(next);
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
    } catch (error) {
      task.attempts += 1;
      task.updated_at = new Date().toISOString();
      task.last_error = error instanceof Error ? error.message : "unknown";
      task.status = task.attempts > this.retryLimit ? "failed" : "pending";
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

    const writeTask = async () => {
      await writeJsonlFileAtomic(this.paths.pendingTasksPath, snapshot);
    };

    const next = this.persistChain
      .catch(() => undefined)
      .then(writeTask);
    this.persistChain = next;
    await next;
  }
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

  return {
    id: typeof raw.id === "string" ? raw.id : randomUUID(),
    type: raw.type,
    status: raw.status,
    payload: raw.payload && typeof raw.payload === "object" ? raw.payload : {},
    source_range: typeof raw.source_range === "string" ? raw.source_range : undefined,
    attempts: Number.isFinite(raw.attempts) ? Math.max(0, Math.floor(raw.attempts)) : 0,
    created_at: typeof raw.created_at === "string" ? raw.created_at : new Date().toISOString(),
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : new Date().toISOString(),
    last_error: typeof raw.last_error === "string" ? raw.last_error : undefined
  };
}
