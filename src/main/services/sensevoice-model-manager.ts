import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import type { AppConfig } from "@shared/types";

const MODEL_BASE_URL = "https://huggingface.co/lovemefan/sense-voice-gguf/resolve/main";

type SenseVoiceModelName = AppConfig["senseVoiceLocal"]["modelName"];

const MODELS: Record<SenseVoiceModelName, { file: string; sizeMB: number }> = {
  "SenseVoiceSmall-int8": { file: "sense-voice-small-q8_0.gguf", sizeMB: 205 }
};

function resolveModelEntry(modelName: string): { file: string; sizeMB: number } {
  return MODELS[modelName as SenseVoiceModelName] ?? MODELS["SenseVoiceSmall-int8"];
}

function asMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return String(error);
}

function shouldRetryDownload(error: unknown): boolean {
  const message = asMessage(error).toLowerCase();
  return (
    message.includes("terminated") ||
    message.includes("fetch failed") ||
    message.includes("socket") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("network")
  );
}

function toFriendlyDownloadError(fileName: string, error: unknown): Error {
  const message = asMessage(error);
  if (shouldRetryDownload(error)) {
    return new Error(
      `下载 SenseVoice 模型 ${fileName} 时连接被中断。请稍后重试，必要时切换网络或代理。原始错误：${message}`
    );
  }

  return new Error(`下载 SenseVoice 模型 ${fileName} 失败：${message}`);
}

export class SenseVoiceModelManager {
  constructor(private readonly modelsDir: string) {
    if (!existsSync(modelsDir)) {
      mkdirSync(modelsDir, { recursive: true });
    }
  }

  getModelPath(modelName: string): string {
    return join(this.modelsDir, resolveModelEntry(modelName).file);
  }

  isModelDownloaded(modelName: string): boolean {
    return existsSync(this.getModelPath(modelName));
  }

  async ensureModel(modelName: string, onProgress?: (percent: number) => void): Promise<string> {
    const modelPath = this.getModelPath(modelName);
    if (existsSync(modelPath)) {
      onProgress?.(100);
      return modelPath;
    }

    const entry = resolveModelEntry(modelName);

    try {
      return await this.downloadModel(entry, modelPath, onProgress);
    } catch (error) {
      throw toFriendlyDownloadError(entry.file, error);
    }
  }

  private async downloadModel(
    entry: { file: string; sizeMB: number },
    modelPath: string,
    onProgress?: (percent: number) => void
  ): Promise<string> {
    const response = await fetch(`${MODEL_BASE_URL}/${entry.file}`);
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }

    const tmpPath = `${modelPath}.downloading`;
    const totalBytes = Number(response.headers.get("content-length")) || entry.sizeMB * 1024 * 1024;
    let downloadedBytes = 0;
    let lastPercent = -1;

    const progressStream = new Transform({
      transform(chunk, _encoding, callback) {
        downloadedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        const percent = Math.max(0, Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)));
        if (percent !== lastPercent) {
          lastPercent = percent;
          onProgress?.(percent);
        }

        callback(null, chunk);
      }
    });

    try {
      await pipeline(
        Readable.fromWeb(response.body as globalThis.ReadableStream<Uint8Array>),
        progressStream,
        createWriteStream(tmpPath)
      );
      await rename(tmpPath, modelPath);
      onProgress?.(100);
      return modelPath;
    } catch (error) {
      rmSync(tmpPath, { force: true });
      throw error;
    }
  }
}
