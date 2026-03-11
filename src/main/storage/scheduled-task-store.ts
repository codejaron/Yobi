import { randomUUID } from "node:crypto";
import type { ScheduledTask, ScheduledTaskRun } from "@shared/types";
import {
  DEFAULT_SCHEDULED_TASKS,
  scheduledTaskRunSchema,
  scheduledTaskSchema,
  type ScheduledTasksDocument
} from "@shared/types";
import type { CompanionPaths } from "./paths";
import {
  appendJsonlLine,
  fileExists,
  readJsonFile,
  readJsonlFile,
  writeJsonFileAtomic
} from "./fs";

export class ScheduledTaskStore {
  private cached: ScheduledTasksDocument = DEFAULT_SCHEDULED_TASKS;

  constructor(private readonly paths: CompanionPaths) {}

  async init(): Promise<void> {
    const exists = await fileExists(this.paths.scheduledTasksPath);
    if (!exists) {
      this.cached = DEFAULT_SCHEDULED_TASKS;
      await writeJsonFileAtomic(this.paths.scheduledTasksPath, this.cached);
      return;
    }

    const raw = await readJsonFile<ScheduledTasksDocument>(this.paths.scheduledTasksPath, DEFAULT_SCHEDULED_TASKS);
    const tasks = Array.isArray(raw.tasks)
      ? raw.tasks
          .map((task) => scheduledTaskSchema.safeParse(task))
          .filter((result) => result.success)
          .map((result) => result.data)
      : [];
    this.cached = { tasks };
    await this.persist();
  }

  list(): ScheduledTask[] {
    return [...this.cached.tasks].sort((a, b) => {
      const aTime = a.nextRunAt ? Date.parse(a.nextRunAt) : Number.POSITIVE_INFINITY;
      const bTime = b.nextRunAt ? Date.parse(b.nextRunAt) : Number.POSITIVE_INFINITY;
      if (aTime !== bTime) {
        return aTime - bTime;
      }
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  get(id: string): ScheduledTask | null {
    return this.cached.tasks.find((task) => task.id === id) ?? null;
  }

  async save(task: ScheduledTask): Promise<ScheduledTask> {
    const existingIndex = this.cached.tasks.findIndex((item) => item.id === task.id);
    if (existingIndex >= 0) {
      this.cached.tasks[existingIndex] = task;
    } else {
      this.cached.tasks.push(task);
    }
    await this.persist();
    return task;
  }

  async remove(id: string): Promise<ScheduledTask | null> {
    const existing = this.get(id);
    if (!existing) {
      return null;
    }
    this.cached.tasks = this.cached.tasks.filter((task) => task.id !== id);
    await this.persist();
    return existing;
  }

  async appendRun(run: Omit<ScheduledTaskRun, "id">): Promise<ScheduledTaskRun> {
    const row: ScheduledTaskRun = {
      id: randomUUID(),
      ...run
    };
    await appendJsonlLine(this.paths.scheduledTaskRunsPath, row);
    return row;
  }

  async listRuns(input?: { limit?: number; taskId?: string }): Promise<ScheduledTaskRun[]> {
    const rows = await readJsonlFile<unknown>(this.paths.scheduledTaskRunsPath);
    const normalized = rows
      .map((row) => scheduledTaskRunSchema.safeParse(row))
      .filter((result) => result.success)
      .map((result) => result.data)
      .filter((row) => (input?.taskId ? row.taskId === input.taskId : true))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    return normalized.slice(0, input?.limit ?? 100);
  }

  private async persist(): Promise<void> {
    await writeJsonFileAtomic(this.paths.scheduledTasksPath, this.cached);
  }
}
