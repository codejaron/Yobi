import { randomUUID } from "node:crypto";

type WsLike = {
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  send: (payload: string | Buffer) => void;
  close: () => void;
};

type AlibabaRegion = "cn" | "intl";

interface VoiceAuthInput {
  apiKey: string;
  region: AlibabaRegion;
}

interface TtsInput extends VoiceAuthInput {
  text: string;
  model: string;
  voice: string;
  timeoutMs: number;
  retryCount: number;
}

interface AsrInput extends VoiceAuthInput {
  pcm: Buffer;
  sampleRate: number;
  model: string;
  timeoutMs: number;
}

const CN_WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
const INTL_WS_URL = "wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference";

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

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, Math.round(value)));
}

function resolveWsUrl(region: AlibabaRegion): string {
  return region === "intl" ? INTL_WS_URL : CN_WS_URL;
}

function asErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "阿里语音服务调用失败";
  }

  const errorObject = payload as {
    header?: {
      error_message?: unknown;
      error_code?: unknown;
    };
    payload?: {
      output?: {
        message?: unknown;
      };
    };
  };

  if (typeof errorObject.header?.error_message === "string" && errorObject.header.error_message.trim()) {
    return errorObject.header.error_message.trim();
  }

  if (typeof errorObject.payload?.output?.message === "string" && errorObject.payload.output.message.trim()) {
    return errorObject.payload.output.message.trim();
  }

  if (typeof errorObject.header?.error_code === "string" && errorObject.header.error_code.trim()) {
    return `阿里语音服务错误：${errorObject.header.error_code.trim()}`;
  }

  return "阿里语音服务调用失败";
}

function parseJsonFrame(raw: unknown): Record<string, unknown> | null {
  if (!raw) {
    return null;
  }

  try {
    if (typeof raw === "string") {
      return JSON.parse(raw) as Record<string, unknown>;
    }

    if (Buffer.isBuffer(raw)) {
      return JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    }

    if (raw instanceof Uint8Array) {
      return JSON.parse(Buffer.from(raw).toString("utf8")) as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

function jsonStringify(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`阿里语音请求超时（${Math.floor(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);

    task
      .then((value) => resolve(value))
      .catch((error) => reject(error))
      .finally(() => clearTimeout(timer));
  });
}

async function createWebSocket(input: {
  url: string;
  apiKey: string;
  timeoutMs: number;
}): Promise<WsLike> {
  const dynamicImport = new Function("moduleName", "return import(moduleName);") as (
    moduleName: string
  ) => Promise<any>;
  const wsModule = await dynamicImport("ws");
  const WebSocketCtor =
    (wsModule as { default?: new (...args: unknown[]) => WsLike }).default ??
    (wsModule as unknown as new (...args: unknown[]) => WsLike);

  return new WebSocketCtor(input.url, {
    handshakeTimeout: input.timeoutMs,
    timeout: input.timeoutMs,
    headers: {
      Authorization: `Bearer ${input.apiKey}`
    }
  });
}

function makeTaskId(): string {
  return `task-${randomUUID().replace(/-/g, "")}`;
}

function splitAudioChunks(input: Buffer, chunkBytes = 3200): Buffer[] {
  if (input.length <= chunkBytes) {
    return [input];
  }

  const chunks: Buffer[] = [];
  for (let offset = 0; offset < input.length; offset += chunkBytes) {
    chunks.push(input.subarray(offset, Math.min(offset + chunkBytes, input.length)));
  }
  return chunks;
}

function normalizeTranscript(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .trim();
}

export class AlibabaVoiceService {
  async synthesize(input: TtsInput): Promise<Buffer> {
    const attempts = Math.max(1, Math.min(6, 1 + clampInt(input.retryCount, 0, 5)));
    const timeoutMs = clampInt(input.timeoutMs, 5000, 120_000);
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

    throw new Error(`阿里语音合成失败：${lastError?.message ?? "未知错误"}`);
  }

  async transcribe(input: AsrInput): Promise<string> {
    if (input.pcm.length === 0) {
      return "";
    }

    const timeoutMs = clampInt(input.timeoutMs, 5000, 120_000);
    const text = await withTimeout(this.transcribeOnce(input), timeoutMs);
    return normalizeTranscript(text);
  }

  private async synthesizeOnce(input: TtsInput): Promise<Buffer> {
    const ws = await createWebSocket({
      url: resolveWsUrl(input.region),
      apiKey: input.apiKey,
      timeoutMs: clampInt(input.timeoutMs, 5000, 120_000)
    });

    const taskId = makeTaskId();

    return new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      const chunks: Buffer[] = [];
      let taskStarted = false;
      let sentTextPayload = false;

      const fail = (error: unknown): void => {
        if (settled) {
          return;
        }

        settled = true;
        try {
          ws.close();
        } catch {}
        reject(normalizeError(error));
      };

      const finish = (): void => {
        if (settled) {
          return;
        }

        settled = true;
        try {
          ws.close();
        } catch {}

        if (chunks.length === 0) {
          reject(new Error("阿里语音合成未返回音频数据"));
          return;
        }

        const audio = Buffer.concat(chunks);
        if (audio.length === 0) {
          reject(new Error("阿里语音合成返回空音频"));
          return;
        }

        resolve(audio);
      };

      ws.on("error", (error) => {
        fail(error);
      });

      ws.on("open", () => {
        try {
          ws.send(
            jsonStringify({
              header: {
                action: "run-task",
                task_id: taskId,
                streaming: "duplex"
              },
              payload: {
                task_group: "audio",
                task: "tts",
                function: "SpeechSynthesizer",
                model: input.model,
                input: {},
                parameters: {
                  voice: input.voice,
                  text_type: "PlainText",
                  format: "mp3",
                  sample_rate: 22050,
                  volume: 50,
                  rate: 1,
                  pitch: 1
                }
              }
            })
          );
        } catch (error) {
          fail(error);
        }
      });

      ws.on("message", (raw, isBinary) => {
        if (settled) {
          return;
        }

        if (isBinary) {
          if (Buffer.isBuffer(raw)) {
            chunks.push(raw);
            return;
          }

          if (raw instanceof Uint8Array) {
            chunks.push(Buffer.from(raw));
            return;
          }

          return;
        }

        const frame = parseJsonFrame(raw);
        if (!frame) {
          return;
        }

        const header = (frame.header ?? {}) as {
          event?: unknown;
        };
        const event = typeof header.event === "string" ? header.event : "";

        if (event === "task-failed") {
          fail(new Error(asErrorMessage(frame)));
          return;
        }

        if (event === "task-started") {
          if (taskStarted || sentTextPayload) {
            return;
          }

          taskStarted = true;
          try {
            ws.send(
              jsonStringify({
                header: {
                  action: "continue-task",
                  task_id: taskId,
                  streaming: "duplex"
                },
                payload: {
                  input: {
                    text: input.text
                  }
                }
              })
            );

            ws.send(
              jsonStringify({
                header: {
                  action: "finish-task",
                  task_id: taskId,
                  streaming: "duplex"
                },
                payload: {
                  input: {}
                }
              })
            );
            sentTextPayload = true;
          } catch (error) {
            fail(error);
          }
          return;
        }

        if (event === "result-generated") {
          const maybeAudioBase64 =
            typeof (frame.payload as { output?: { audio?: unknown } } | undefined)?.output?.audio ===
            "string"
              ? ((frame.payload as { output?: { audio?: string } }).output?.audio ?? "")
              : "";

          if (maybeAudioBase64) {
            chunks.push(Buffer.from(maybeAudioBase64, "base64"));
          }
          return;
        }

        if (event === "task-finished") {
          finish();
        }
      });

      ws.on("close", () => {
        if (settled) {
          return;
        }

        if (chunks.length > 0) {
          finish();
          return;
        }

        fail(new Error("阿里语音合成连接关闭且无音频返回"));
      });
    });
  }

  private async transcribeOnce(input: AsrInput): Promise<string> {
    const ws = await createWebSocket({
      url: resolveWsUrl(input.region),
      apiKey: input.apiKey,
      timeoutMs: clampInt(input.timeoutMs, 5000, 120_000)
    });

    const taskId = makeTaskId();

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const pieces: string[] = [];
      let latestPartial = "";
      let audioSent = false;

      const fail = (error: unknown): void => {
        if (settled) {
          return;
        }

        settled = true;
        try {
          ws.close();
        } catch {}
        reject(normalizeError(error));
      };

      const appendPiece = (text: string): void => {
        const normalized = normalizeTranscript(text);
        if (!normalized) {
          return;
        }

        if (pieces.at(-1) === normalized) {
          return;
        }

        pieces.push(normalized);
      };

      const finish = (): void => {
        if (settled) {
          return;
        }

        settled = true;
        try {
          ws.close();
        } catch {}

        if (pieces.length === 0 && latestPartial) {
          appendPiece(latestPartial);
        }

        resolve(pieces.join(" ").trim());
      };

      ws.on("error", (error) => {
        fail(error);
      });

      ws.on("open", () => {
        try {
          ws.send(
            jsonStringify({
              header: {
                action: "run-task",
                task_id: taskId,
                streaming: "duplex"
              },
              payload: {
                task_group: "audio",
                task: "asr",
                function: "recognition",
                model: input.model,
                input: {},
                parameters: {
                  format: "pcm",
                  sample_rate: clampInt(input.sampleRate, 8000, 48_000),
                  disfluency_removal_enabled: true,
                  language_hints: ["zh", "en"]
                }
              }
            })
          );
        } catch (error) {
          fail(error);
        }
      });

      ws.on("message", (raw, isBinary) => {
        if (settled || isBinary) {
          return;
        }

        const frame = parseJsonFrame(raw);
        if (!frame) {
          return;
        }

        const header = (frame.header ?? {}) as {
          event?: unknown;
        };
        const event = typeof header.event === "string" ? header.event : "";

        if (event === "task-failed") {
          fail(new Error(asErrorMessage(frame)));
          return;
        }

        if (event === "task-started") {
          if (audioSent) {
            return;
          }

          audioSent = true;
          try {
            const audioChunks = splitAudioChunks(input.pcm);
            for (const audioChunk of audioChunks) {
              ws.send(audioChunk);
            }

            ws.send(
              jsonStringify({
                header: {
                  action: "finish-task",
                  task_id: taskId,
                  streaming: "duplex"
                },
                payload: {
                  input: {}
                }
              })
            );
          } catch (error) {
            fail(error);
          }
          return;
        }

        if (event === "result-generated") {
          const sentence =
            (frame.payload as { output?: { sentence?: { text?: unknown; end?: unknown } } } | undefined)
              ?.output?.sentence;

          const sentenceText = typeof sentence?.text === "string" ? sentence.text : "";
          if (!sentenceText) {
            return;
          }

          latestPartial = sentenceText;
          if (sentence?.end === true) {
            appendPiece(sentenceText);
          }
          return;
        }

        if (event === "task-finished") {
          finish();
        }
      });

      ws.on("close", () => {
        if (settled) {
          return;
        }

        finish();
      });
    });
  }
}
