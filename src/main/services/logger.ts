import path from "node:path";
import { promises as fs } from "node:fs";
import { CompanionPaths } from "@main/storage/paths";

export type LogLevel = "info" | "warn" | "error";

export interface LogEvent {
  module: string;
  level: LogLevel;
  event: string;
  message?: string;
  task_id?: string;
  attempt?: number;
  duration_ms?: number;
  degraded_mode?: boolean;
  detail?: Record<string, unknown>;
  error?: string;
  timestamp?: string;
}

export class AppLogger {
  constructor(private readonly paths: CompanionPaths) {}

  async cleanup(retentionDays = 14): Promise<void> {
    const cutoffMs = Date.now() - retentionDays * 24 * 3600 * 1000;
    let names: string[] = [];
    try {
      names = await fs.readdir(this.paths.logsDir);
    } catch {
      return;
    }

    await Promise.all(
      names
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
        .map(async (name) => {
          const day = name.replace(/\.jsonl$/, "");
          const parsed = new Date(`${day}T00:00:00.000Z`).getTime();
          if (!Number.isFinite(parsed) || parsed >= cutoffMs) {
            return;
          }
          await fs.rm(path.join(this.paths.logsDir, name), { force: true });
        })
    );
  }

  info(module: string, event: string, detail?: Record<string, unknown>): void {
    void this.safeWrite({ module, event, level: "info", detail });
  }

  warn(module: string, event: string, detail?: Record<string, unknown>, error?: unknown): void {
    const serializedError = stringifyError(error);
    console.warn(`[${module}] ${event}`, detail ?? {}, serializedError ?? "");
    void this.safeWrite({ module, event, level: "warn", detail, error: serializedError });
  }

  error(module: string, event: string, detail?: Record<string, unknown>, error?: unknown): void {
    const serializedError = stringifyError(error);
    console.error(`[${module}] ${event}`, detail ?? {}, serializedError ?? "");
    void this.safeWrite({ module, event, level: "error", detail, error: serializedError });
  }


  private async safeWrite(input: LogEvent): Promise<void> {
    try {
      await this.write(input);
    } catch {
      // logging must never break app flow
    }
  }

  async write(input: LogEvent): Promise<void> {
    const timestamp = input.timestamp ?? new Date().toISOString();
    const dayKey = timestamp.slice(0, 10);
    const target = path.join(this.paths.logsDir, `${dayKey}.jsonl`);
    const payload = JSON.stringify({
      timestamp,
      module: input.module,
      level: input.level,
      event: input.event,
      message: input.message,
      task_id: input.task_id,
      attempt: input.attempt,
      duration_ms: input.duration_ms,
      degraded_mode: input.degraded_mode,
      detail: input.detail,
      error: input.error
    });
    await fs.mkdir(this.paths.logsDir, { recursive: true });
    await fs.appendFile(target, `${payload}\n`, "utf8");
  }
}

function stringifyError(error: unknown): string | undefined {
  if (!error) {
    return undefined;
  }
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
