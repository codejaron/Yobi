import path from "node:path";
import type { AppConfig, BufferMessage } from "@shared/types";

interface WorkerMessage {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface BackgroundWorkerStatus {
  available: boolean;
  message: string;
}

export interface FactExtractionWorkerResult {
  operations: Array<{
    action: "add" | "update" | "supersede";
    fact: {
      entity: string;
      key: string;
      value: string;
      category: "identity" | "preference" | "event" | "goal" | "relationship" | "emotion_pattern";
      confidence: number;
      ttl_class: "permanent" | "stable" | "active" | "session";
      source?: string;
      source_range?: string;
    };
  }>;
  tokenUsage?: unknown;
}

export class BackgroundTaskWorkerService {
  private worker: any = null;
  private ready = false;
  private message = "disabled";
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  async init(): Promise<void> {
    if (this.ready) {
      return;
    }
    if (!process.versions.electron) {
      this.message = "node-fallback";
      return;
    }

    try {
      const electron = await import("electron");
      const workerPath = path.join(electron.app.getAppPath(), "src", "main", "workers", "background-task-worker.cjs");
      const child = electron.utilityProcess.fork(workerPath, [], {
        serviceName: "yobi-background-worker"
      });
      child.on("message", (message: WorkerMessage) => {
        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }
        this.pending.delete(message.id);
        if (message.ok) {
          pending.resolve(message.result);
          return;
        }
        pending.reject(new Error(message.error || "background-worker-call-failed"));
      });
      child.once?.("exit", () => {
        this.worker = null;
        this.ready = false;
        this.message = "worker-exited";
      });
      this.worker = child;
      this.ready = true;
      this.message = "ready";
    } catch (error) {
      this.worker = null;
      this.ready = false;
      this.message = error instanceof Error ? error.message : "worker-init-failed";
    }
  }

  getStatus(): BackgroundWorkerStatus {
    return {
      available: this.ready && Boolean(this.worker),
      message: this.message
    };
  }

  async runFactExtraction(input: {
    messages: BufferMessage[];
    existingFacts: unknown;
    profileHint: unknown;
    config: AppConfig;
    maxOutputTokens?: number;
  }): Promise<FactExtractionWorkerResult> {
    return this.call("fact-extraction", input) as Promise<FactExtractionWorkerResult>;
  }

  async runDailyEpisode(input: {
    date: string;
    todayItems: Array<{ role: string; text: string }>;
    userMessageCount: number;
    fallbackSummary: string;
    config: AppConfig;
  }): Promise<{ summary: string; unresolved: string[]; significance: number; tokenUsage?: unknown }> {
    return this.call("daily-episode", input) as Promise<{ summary: string; unresolved: string[]; significance: number; tokenUsage?: unknown }>;
  }

  async runProfileSemantic(input: {
    profile: unknown;
    episodes: Array<{ date: string; summary: string }>;
    config: AppConfig;
  }): Promise<{ result: unknown; tokenUsage?: unknown }> {
    return this.call("profile-semantic-update", input) as Promise<{ result: unknown; tokenUsage?: unknown }>;
  }

  async runDailyReflection(input: {
    episodes: Array<{ date: string; summary: string; significance: number }>;
    config: AppConfig;
  }): Promise<{ result: unknown; tokenUsage?: unknown }> {
    return this.call("daily-reflection", input) as Promise<{ result: unknown; tokenUsage?: unknown }>;
  }

  private async call(type: string, payload: Record<string, unknown>): Promise<unknown> {
    if (!this.worker || !this.ready) {
      throw new Error("background-worker-unavailable");
    }

    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...payload });
    });
  }
}
