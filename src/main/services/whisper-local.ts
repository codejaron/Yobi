import { createRequire } from "node:module";
import type { WhisperContext } from "whisper-cpp-node";

const require = createRequire(import.meta.url);
const { createWhisperContext, transcribeAsync } = require("whisper-cpp-node") as typeof import("whisper-cpp-node");

function pcm16ToFloat32(pcm: Buffer): Float32Array {
  const safeLength = pcm.length - (pcm.length % 2);
  const sampleCount = safeLength / 2;
  const output = new Float32Array(sampleCount);

  for (let index = 0; index < sampleCount; index += 1) {
    output[index] = pcm.readInt16LE(index * 2) / 0x8000;
  }

  return output;
}

function resampleFloat32(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (input.length === 0 || fromRate === toRate) {
    return input;
  }

  const ratio = fromRate / toRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const leftIndex = Math.floor(position);
    const rightIndex = Math.min(leftIndex + 1, input.length - 1);
    const mix = position - leftIndex;
    const left = input[leftIndex] ?? 0;
    const right = input[rightIndex] ?? left;
    output[index] = left + (right - left) * mix;
  }

  return output;
}

export class WhisperLocalService {
  private ctx: WhisperContext | null = null;
  private modelPath: string | null = null;
  private loadingPromise: Promise<void> | null = null;
  private loadError: Error | null = null;
  private generation = 0;

  configureModel(modelPath: string | null): void {
    if (!modelPath) {
      this.reset();
      return;
    }

    if (this.modelPath === modelPath && (this.ctx || this.loadingPromise)) {
      return;
    }

    this.dispose();
    this.modelPath = modelPath;
    this.loadError = null;
    const generation = ++this.generation;

    this.loadingPromise = this.init(modelPath)
      .catch((error) => {
        if (this.generation === generation) {
          this.loadError = error instanceof Error ? error : new Error(String(error));
          this.disposeContextOnly();
        }
      })
      .finally(() => {
        if (this.generation === generation) {
          this.loadingPromise = null;
        }
      });
  }

  reset(): void {
    this.generation += 1;
    this.dispose();
    this.modelPath = null;
    this.loadError = null;
    this.loadingPromise = null;
  }

  async transcribe(input: { pcm: Buffer; sampleRate: number }): Promise<string> {
    if (this.loadingPromise) {
      await this.loadingPromise;
    }

    if (this.loadError) {
      throw new Error(`本地 Whisper 初始化失败：${this.loadError.message}`);
    }

    if (!this.ctx) {
      throw new Error("本地 Whisper 模型未就绪，请先下载模型并保存设置。");
    }

    const pcmf32 =
      input.sampleRate === 16_000
        ? pcm16ToFloat32(input.pcm)
        : resampleFloat32(pcm16ToFloat32(input.pcm), input.sampleRate, 16_000);

    const result = await transcribeAsync(this.ctx, {
      pcmf32,
      language: "auto",
      translate: false,
      no_timestamps: true
    });

    return result.segments
      .map((segment) => segment.text)
      .join("")
      .trim();
  }

  isReady(): boolean {
    return this.ctx !== null && this.loadError === null;
  }

  getLoadErrorMessage(): string | null {
    return this.loadError?.message ?? null;
  }

  private async init(modelPath: string): Promise<void> {
    this.ctx = createWhisperContext({
      model: modelPath,
      use_gpu: true,
      no_prints: true
    });
  }

  private dispose(): void {
    this.disposeContextOnly();
  }

  private disposeContextOnly(): void {
    this.ctx?.free();
    this.ctx = null;
  }
}
