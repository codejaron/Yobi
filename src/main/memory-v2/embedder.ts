import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { CompanionPaths } from "@main/storage/paths";
import type { AppConfig } from "@shared/types";

export type EmbedderStatus = "disabled" | "loading" | "ready" | "error";

export interface EmbeddingResult {
  modelId: string;
  vector: number[];
}

interface ConceptDefinition {
  label: string;
  terms: string[];
}

interface WorkerReply {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const HASH_VECTOR_SIZE = 48;
const CONCEPT_VECTOR_SIZE = 16;
const TOTAL_VECTOR_SIZE = HASH_VECTOR_SIZE + CONCEPT_VECTOR_SIZE;
const DEFAULT_MODEL_ID = "embeddinggemma-300m-qat-Q8_0.gguf";
const DEFAULT_MODEL_URL = "https://huggingface.co/ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/resolve/main/embeddinggemma-300m-qat-Q8_0.gguf";

const CONCEPTS: ConceptDefinition[] = [
  { label: "fatigue-workload", terms: ["累", "疲惫", "困", "忙", "压力", "加班", "工作多", "工作很满", "撑不住", "上班"] },
  { label: "sadness", terms: ["难过", "低落", "沮丧", "伤心", "想哭"] },
  { label: "anxiety", terms: ["焦虑", "担心", "不安", "慌", "紧张"] },
  { label: "joy", terms: ["开心", "高兴", "快乐", "兴奋", "期待"] },
  { label: "games", terms: ["原神", "游戏", "米哈游", "steam", "switch"] },
  { label: "study", terms: ["学习", "考试", "作业", "论文", "上课"] },
  { label: "sleep", terms: ["睡", "失眠", "熬夜", "困", "补觉"] },
  { label: "food", terms: ["吃", "饭", "火锅", "奶茶", "咖啡"] }
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(text: string): string[] {
  const normalized = normalize(text);
  const englishTokens = normalized.match(/[a-z0-9_]{2,24}/g) ?? [];
  const cjkChars = [...normalized].filter((char) => /[\u3400-\u9fff]/.test(char));
  const cjkTokens: string[] = [];
  for (const gramSize of [2, 3]) {
    if (cjkChars.length < gramSize) {
      continue;
    }
    for (let index = 0; index <= cjkChars.length - gramSize; index += 1) {
      cjkTokens.push(cjkChars.slice(index, index + gramSize).join(""));
    }
  }
  return [...englishTokens, ...cjkTokens];
}

function hashToken(token: string): number {
  let hash = 0;
  for (const char of token) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm <= 0) {
    return vector;
  }
  return vector.map((value) => value / norm);
}

function heuristicEmbed(text: string): number[] {
  const vector = new Array<number>(TOTAL_VECTOR_SIZE).fill(0);
  const normalized = normalize(text);
  for (const token of tokenize(normalized)) {
    const bucket = hashToken(token) % HASH_VECTOR_SIZE;
    vector[bucket] += token.length >= 3 ? 0.5 : 0.3;
  }

  CONCEPTS.slice(0, CONCEPT_VECTOR_SIZE).forEach((concept, index) => {
    const matched = concept.terms.some((term) => normalized.includes(term));
    if (matched) {
      vector[HASH_VECTOR_SIZE + index] += 6;
    }
  });

  return normalizeVector(vector);
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
  private backend: "heuristic" | "utility-llama" | "utility-heuristic" = "heuristic";
  private modelPath: string | null = null;
  private worker: any = null;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
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

  getStatus(): { status: EmbedderStatus; message: string } {
    const suffix = this.modelPath ? ` (${path.basename(this.modelPath)})` : "";
    return {
      status: this.status,
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
      this.backend = "heuristic";
      return null;
    }

    if (!this.initPromise) {
      this.init();
    }
    await this.initPromise;

    if (this.worker) {
      try {
        const result = await this.callWorker("embed", { text: trimmed }) as EmbeddingResult;
        return {
          modelId: result.modelId,
          vector: normalizeVector(result.vector ?? [])
        };
      } catch (error) {
        this.backend = "heuristic";
        this.errorMessage = error instanceof Error ? `heuristic fallback: ${error.message}` : "heuristic fallback";
      }
    }

    return {
      modelId: this.getCurrentModelId(),
      vector: heuristicEmbed(trimmed)
    };
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
      this.backend = "heuristic";
      this.status = "ready";
      this.errorMessage = "heuristic-local-embedder";
      return;
    }

    if (!this.modelPath) {
      this.backend = "heuristic";
      this.status = "ready";
      const downloadUrl = resolveDownloadUrl(this.getCurrentModelId());
      if (downloadUrl) {
        this.errorMessage = "正在后台下载 GGUF，当前使用 heuristic fallback";
        this.downloadPromise ??= this.downloadModelInBackground(downloadUrl);
      } else {
        this.errorMessage = "未找到本地 GGUF，当前使用 heuristic fallback";
      }
      return;
    }

    await this.initializeWorkerBackend();
  }

  private async initializeWorkerBackend(): Promise<void> {
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
        if (message.ok) {
          pending.resolve(message.result);
          return;
        }
        pending.reject(new Error(message.error || "worker-call-failed"));
      });
      child.once?.("exit", () => {
        this.worker = null;
        this.backend = "heuristic";
        this.errorMessage = "heuristic fallback: embedding worker exited";
      });
      this.worker = child;

      const initResult = await this.callWorker("init", {
        modelId: this.getCurrentModelId(),
        modelPath: this.modelPath
      }) as { backend?: string; message?: string };
      this.backend = initResult.backend === "llama" ? "utility-llama" : "utility-heuristic";
      this.status = "ready";
      this.errorMessage = initResult.message || (this.backend === "utility-llama" ? "llama-local-embedder" : "heuristic-local-embedder");
      return;
    } catch (error) {
      this.worker = null;
      this.backend = "heuristic";
      this.status = "ready";
      this.errorMessage = error instanceof Error ? `heuristic fallback: ${error.message}` : "heuristic fallback";
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
      this.errorMessage = "GGUF 下载完成，正在切换到 llama embedder";
      await this.initializeWorkerBackend();
    } catch (error) {
      this.errorMessage = error instanceof Error ? `GGUF 下载失败：${error.message}` : "GGUF 下载失败";
      this.backend = "heuristic";
      this.status = "ready";
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
      this.pending.set(id, { resolve, reject });
      this.worker?.postMessage({
        id,
        type,
        ...payload
      });
    });
  }
}
