import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { CompanionPaths } from "@main/storage/paths";
import { appLogger as logger } from "@main/runtime/singletons";
import type { AppConfig, EmbedderRuntimeStatus } from "@shared/types";

export type EmbedderStatus = "disabled" | "loading" | "ready" | "error";

export interface EmbeddingResult {
  modelId: string;
  vector: number[];
}

interface WorkerReply {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PendingWorkerCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_MODEL_ID = "embeddinggemma-300m-qat-Q8_0.gguf";
const DEFAULT_MODEL_URL = "https://huggingface.co/ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/resolve/main/embeddinggemma-300m-qat-Q8_0.gguf";
const WORKER_CALL_TIMEOUT_MS = 20_000;

function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm <= 0) {
    return vector;
  }
  return vector.map((value) => value / norm);
}

function resolveModelPath(paths: CompanionPaths, modelId: string): string | null {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return null;
  }

  const directCandidate = path.isAbsolute(trimmed) ? trimmed : path.join(paths.embeddingModelsDir, trimmed);
  if (fs.existsSync(directCandidate)) {
    return directCandidate;
  }

  return null;
}

function resolveDownloadUrl(modelId: string): string | null {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return null;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed === DEFAULT_MODEL_ID || trimmed === DEFAULT_MODEL_ID.toLowerCase()) {
    return DEFAULT_MODEL_URL;
  }
  return null;
}

export class EmbedderService {
  private status: EmbedderStatus = "disabled";
  private errorMessage = "";
  private initPromise: Promise<void> | null = null;
  private modelPath: string | null = null;
  private worker: any = null;
  private pending = new Map<string, PendingWorkerCall>();
  private downloadPromise: Promise<void> | null = null;

  constructor(
    private readonly paths: CompanionPaths,
    private readonly getConfig: () => AppConfig
  ) {}

  init(): void {
    if (this.initPromise) {
      return;
    }
    this.initPromise = this.initialize();
  }

  getStatus(): EmbedderRuntimeStatus {
    const suffix = this.modelPath ? ` (${path.basename(this.modelPath)})` : "";
    return {
      status: this.status,
      mode: this.status === "ready" ? "vector-only" : this.status === "disabled" ? "disabled" : "bm25-only",
      downloadPending: this.downloadPromise !== null,
      message: `${this.errorMessage}${suffix}`.trim()
    };
  }

  getCurrentModelId(): string {
    return this.getConfig().memory.embedding.modelId;
  }

  async embed(text: string): Promise<EmbeddingResult | null> {
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }

    if (!this.getConfig().memory.embedding.enabled) {
      this.status = "disabled";
      this.errorMessage = "embedding disabled";
      return null;
    }

    if (!this.initPromise) {
      this.init();
    }
    await this.initPromise;

    if (!this.worker || this.status !== "ready") {
      return null;
    }

    try {
      const result = await this.callWorker("embed", { text: trimmed }) as EmbeddingResult;
      const vector = normalizeVector(result.vector ?? []);
      if (vector.length === 0) {
        return null;
      }
      return {
        modelId: result.modelId,
        vector
      };
    } catch (error) {
      logger.warn("embedder", "embed-call-failed", { modelId: this.getCurrentModelId() }, error);
      this.disposeWorker();
      this.status = "error";
      this.errorMessage = error instanceof Error ? error.message : "vector-unavailable";
      return null;
    }
  }

  private async initialize(): Promise<void> {
    if (!this.getConfig().memory.embedding.enabled) {
      this.status = "disabled";
      this.errorMessage = "embedding disabled";
      return;
    }

    this.status = "loading";
    this.errorMessage = "";
    this.modelPath = resolveModelPath(this.paths, this.getCurrentModelId());

    if (!process.versions.electron) {
      this.status = "error";
      this.errorMessage = "vector embedder unavailable in node runtime";
      return;
    }

    if (!this.modelPath) {
      const downloadUrl = resolveDownloadUrl(this.getCurrentModelId());
      this.status = "error";
      if (downloadUrl) {
        this.errorMessage = "正在后台下载 GGUF，当前仅词法检索";
        this.downloadPromise ??= this.downloadModelInBackground(downloadUrl);
      } else {
        this.errorMessage = "未找到本地 GGUF，当前仅词法检索";
      }
      return;
    }

    await this.initializeWorkerBackend();
  }

  private async initializeWorkerBackend(): Promise<void> {
    this.disposeWorker();

    try {
      const electron = await import("electron");
      const workerScript = path.join(electron.app.getAppPath(), "src", "main", "workers", "embedding-worker.cjs");
      const child = electron.utilityProcess.fork(workerScript, [], {
        serviceName: "yobi-embedding-worker"
      });

      child.on("message", (message: WorkerReply) => {
        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }
        this.pending.delete(message.id);
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
        if (message.ok) {
          pending.resolve(message.result);
          return;
        }
        pending.reject(new Error(message.error || "worker-call-failed"));
      });

      child.once?.("exit", (code: number | null) => {
        if (this.worker === child) {
          this.worker = null;
        }
        const exitError = new Error(`embedding worker exited (code: ${code ?? "unknown"})`);
        logger.error("embedder", "worker-exited", {
          modelId: this.getCurrentModelId(),
          modelPath: this.modelPath,
          code: code ?? "unknown"
        }, exitError);
        this.rejectPendingCalls(exitError);
        this.status = "error";
        this.errorMessage = exitError.message;
      });

      const childWithLooseEvents = child as {
        once?: (event: string, listener: (...args: unknown[]) => void) => void;
      };
      childWithLooseEvents.once?.("error", (error: unknown) => {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        if (this.worker === child) {
          this.worker = null;
        }
        logger.error("embedder", "worker-error", {
          modelId: this.getCurrentModelId(),
          modelPath: this.modelPath
        }, normalizedError);
        this.rejectPendingCalls(normalizedError);
        this.status = "error";
        this.errorMessage = normalizedError.message;
      });

      this.worker = child;

      const nodeLlamaModuleUrl = pathToFileURL(
        path.join(electron.app.getAppPath(), "node_modules", "node-llama-cpp", "dist", "index.js")
      ).href;
      await this.callWorker("init", {
        modelId: this.getCurrentModelId(),
        modelPath: this.modelPath,
        nodeLlamaModuleUrl,
        preferredGpu: process.platform === "darwin" ? "metal" : "auto"
      });
      this.status = "ready";
      this.errorMessage = "llama-local-embedder";
    } catch (error) {
      logger.error("embedder", "worker-init-failed", {
        modelId: this.getCurrentModelId(),
        modelPath: this.modelPath
      }, error);
      this.disposeWorker();
      this.status = "error";
      this.errorMessage = error instanceof Error ? error.message : "vector-unavailable";
    }
  }

  private async downloadModelInBackground(downloadUrl: string): Promise<void> {
    try {
      await fs.promises.mkdir(this.paths.embeddingModelsDir, { recursive: true });
      const response = await fetch(downloadUrl);
      if (!response.ok || !response.body) {
        throw new Error(`download failed: ${response.status}`);
      }
      const targetName = path.basename(new URL(downloadUrl).pathname) || DEFAULT_MODEL_ID;
      const targetPath = path.join(this.paths.embeddingModelsDir, targetName);
      const tempPath = `${targetPath}.partial`;
      const fileStream = fs.createWriteStream(tempPath);
      const nodeStream = Readable.fromWeb(response.body);
      await new Promise<void>((resolve, reject) => {
        nodeStream.on("error", reject);
        fileStream.on("error", reject);
        fileStream.on("finish", resolve);
        nodeStream.pipe(fileStream);
      });
      await fs.promises.rename(tempPath, targetPath);
      this.modelPath = targetPath;
      this.errorMessage = "GGUF 下载完成，正在切换到向量检索";
      await this.initializeWorkerBackend();
    } catch (error) {
      logger.error("embedder", "gguf-download-failed", {
        modelId: this.getCurrentModelId(),
        downloadUrl
      }, error);
      this.status = "error";
      this.errorMessage = error instanceof Error ? `GGUF 下载失败：${error.message}` : "GGUF 下载失败";
    } finally {
      this.downloadPromise = null;
    }
  }

  private callWorker(type: string, payload: Record<string, unknown>): Promise<unknown> {
    if (!this.worker) {
      return Promise.reject(new Error("embedding-worker-unavailable"));
    }

    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const timeoutError = new Error(`embedding-worker-timeout:${type}`);
        logger.error("embedder", "worker-call-timeout", {
          type,
          modelId: this.getCurrentModelId(),
          modelPath: this.modelPath,
          timeoutMs: WORKER_CALL_TIMEOUT_MS
        }, timeoutError);
        reject(timeoutError);
      }, WORKER_CALL_TIMEOUT_MS);
      timer.unref?.();

      this.pending.set(id, { resolve, reject, timer });
      this.worker?.postMessage({
        id,
        type,
        ...payload
      });
    });
  }

  private rejectPendingCalls(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private disposeWorker(): void {
    const worker = this.worker;
    this.worker = null;
    this.rejectPendingCalls(new Error("embedding-worker-restarted"));
    if (worker?.kill) {
      try {
        worker.kill();
      } catch {}
    }
  }
}
