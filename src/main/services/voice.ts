import { Communicate } from "edge-tts-universal";

export interface VoiceConfig {
  voice: string;
  rate: string;
  pitch: string;
  requestTimeoutMs: number;
  retryCount: number;
}

const DEFAULT_EDGE_VOICE = "zh-CN-XiaoxiaoNeural";
const DEFAULT_VOLUME = "+0%";
const MIN_TIMEOUT_MS = 3000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RETRY_COUNT = 5;

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return new Error((error as { message: string }).message);
  }

  return new Error(String(error));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Edge TTS 请求超时（${Math.floor(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);

    promise
      .then((value) => resolve(value))
      .catch((error) => reject(error))
      .finally(() => clearTimeout(timer));
  });
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, Math.round(value)));
}

function resolveProxyFromEnv(): string | undefined {
  const candidates = [
    process.env.HTTPS_PROXY,
    process.env.HTTP_PROXY,
    process.env.ALL_PROXY,
    process.env.https_proxy,
    process.env.http_proxy,
    process.env.all_proxy
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const normalized = candidate.trim();
      if (normalized) {
        return normalized;
      }
    }
  }

  return undefined;
}

function resolveVoice(voice: string): string {
  const normalized = voice.trim();
  return normalized || DEFAULT_EDGE_VOICE;
}

function resolveProsody(raw: string): string | undefined {
  const normalized = raw.trim();
  return normalized || undefined;
}

export class VoiceService {
  async synthesize(input: { text: string; config: VoiceConfig }): Promise<Buffer> {
    const retries = clampInt(input.config.retryCount, 0, MAX_RETRY_COUNT);
    const attempts = retries + 1;
    const timeoutMs = clampInt(input.config.requestTimeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await withTimeout(this.synthesizeOnce(input), timeoutMs);
      } catch (error) {
        lastError = normalizeError(error);
        if (attempt >= attempts - 1) {
          break;
        }

        await sleep(400 * (attempt + 1));
      }
    }

    throw new Error(`Edge TTS 合成失败：${lastError?.message ?? "未知错误"}`);
  }

  private async synthesizeOnce(input: { text: string; config: VoiceConfig }): Promise<Buffer> {
    const text = input.text.trim();
    if (!text) {
      throw new Error("Edge TTS 输入文本为空");
    }

    const timeoutMs = clampInt(input.config.requestTimeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const proxy = resolveProxyFromEnv();
    const communicate = new Communicate(text, {
      voice: resolveVoice(input.config.voice),
      rate: resolveProsody(input.config.rate),
      pitch: resolveProsody(input.config.pitch),
      volume: DEFAULT_VOLUME,
      proxy,
      connectionTimeout: timeoutMs
    });

    const audioChunks: Buffer[] = [];
    for await (const chunk of communicate.stream()) {
      if (chunk.type === "audio" && chunk.data && chunk.data.length > 0) {
        audioChunks.push(Buffer.from(chunk.data));
      }
    }

    if (audioChunks.length === 0) {
      throw new Error("Edge TTS 未返回音频数据");
    }

    const audio = Buffer.concat(audioChunks);
    if (audio.length === 0) {
      throw new Error("Edge TTS 返回空音频");
    }

    return audio;
  }
}
