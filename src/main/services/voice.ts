import { createHash, randomBytes, randomUUID } from "node:crypto";

export interface VoiceConfig {
  voice: string;
  rate: string;
  pitch: string;
  requestTimeoutMs: number;
  retryCount: number;
}

type WsLike = {
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  send: (payload: string | Buffer) => void;
  close: () => void;
};

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0] ?? "143";
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const WSS_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const DEFAULT_VOLUME = "+0%";

function normalizeError(error: unknown): Error {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return new Error((error as { message: string }).message);
  }

  if (error instanceof Error) {
    return error;
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

function generateSecMsGec(nowMs = Date.now()): string {
  const winEpoch = 11_644_473_600;
  const sToNs = 1_000_000_000;
  let ticks = nowMs / 1000 + winEpoch;
  ticks -= ticks % 300;
  ticks *= sToNs / 100;

  return createHash("sha256")
    .update(`${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`, "ascii")
    .digest("hex")
    .toUpperCase();
}

function createConnectionId(): string {
  return randomUUID().replace(/-/g, "");
}

function createMuid(): string {
  return randomBytes(16).toString("hex").toUpperCase();
}

function formatUtcDateForEdge(date = new Date()): string {
  const week = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const dayName = week[date.getUTCDay()] ?? "Mon";
  const month = months[date.getUTCMonth()] ?? "Jan";
  const day = String(date.getUTCDate()).padStart(2, "0");
  const year = String(date.getUTCFullYear());
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");

  return `${dayName} ${month} ${day} ${year} ${hour}:${minute}:${second} GMT+0000 (Coordinated Universal Time)`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function parseHeaderLines(headerText: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of headerText.split("\r\n")) {
    const index = line.indexOf(":");
    if (index <= 0) {
      continue;
    }

    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key && value) {
      headers[key] = value;
    }
  }
  return headers;
}

function splitTextFrame(raw: string | Buffer): [Record<string, string>, string] {
  const message = typeof raw === "string" ? raw : raw.toString("utf8");
  const splitAt = message.indexOf("\r\n\r\n");
  if (splitAt < 0) {
    return [{}, message];
  }

  const headers = parseHeaderLines(message.slice(0, splitAt));
  const body = message.slice(splitAt + 4);
  return [headers, body];
}

function toBuffer(raw: unknown): Buffer {
  if (Buffer.isBuffer(raw)) {
    return raw;
  }

  if (raw instanceof Uint8Array) {
    return Buffer.from(raw);
  }

  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw);
  }

  if (Array.isArray(raw)) {
    return Buffer.concat(raw.map((item) => toBuffer(item)));
  }

  throw new Error("Edge TTS WebSocket 返回了未知数据类型");
}

function splitBinaryFrame(raw: Buffer): [Record<string, string>, Buffer] {
  if (raw.length < 2) {
    throw new Error("Edge TTS 二进制帧缺少头长度");
  }

  const headerLength = raw.readUInt16BE(0);
  const totalHeaderBytes = headerLength + 2;
  if (totalHeaderBytes > raw.length) {
    throw new Error("Edge TTS 二进制帧头长度非法");
  }

  const headerText = raw.subarray(2, totalHeaderBytes).toString("utf8");
  const body = raw.subarray(totalHeaderBytes);
  return [parseHeaderLines(headerText), body];
}

async function createWebSocket(input: {
  url: string;
  connectionTimeoutMs: number;
  headers: Record<string, string>;
}): Promise<WsLike> {
  const dynamicImport = new Function("moduleName", "return import(moduleName);") as (
    moduleName: string
  ) => Promise<any>;
  const wsModule = await dynamicImport("ws");
  const WebSocketCtor =
    (wsModule as { default?: new (...args: unknown[]) => WsLike }).default ??
    (wsModule as unknown as new (...args: unknown[]) => WsLike);
  const options: Record<string, unknown> = {
    headers: input.headers,
    timeout: input.connectionTimeoutMs,
    handshakeTimeout: input.connectionTimeoutMs
  };

  return new WebSocketCtor(input.url, options);
}

function buildWebSocketHeaders(): Record<string, string> {
  const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`;
  return {
    "User-Agent": userAgent,
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    "Pragma": "no-cache",
    "Cache-Control": "no-cache",
    "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
    "Sec-WebSocket-Version": "13",
    "Cookie": `muid=${createMuid()};`
  };
}

function buildWebSocketUrl(): string {
  const secMsGec = generateSecMsGec();
  const connectionId = createConnectionId();
  return `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${connectionId}`;
}

function buildSpeechConfigFrame(timestamp: string): string {
  return [
    `X-Timestamp:${timestamp}`,
    "Content-Type:application/json; charset=utf-8",
    "Path:speech.config",
    "",
    "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"true\"},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}",
    ""
  ].join("\r\n");
}

function buildSsmlFrame(input: {
  requestId: string;
  timestamp: string;
  text: string;
  config: VoiceConfig;
}): string {
  const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='${input.config.voice}'><prosody pitch='${input.config.pitch}' rate='${input.config.rate}' volume='${DEFAULT_VOLUME}'>${escapeXml(input.text)}</prosody></voice></speak>`;
  return [
    `X-RequestId:${input.requestId}`,
    "Content-Type:application/ssml+xml",
    `X-Timestamp:${input.timestamp}Z`,
    "Path:ssml",
    "",
    ssml
  ].join("\r\n");
}

export class VoiceService {
  async synthesize(input: { text: string; config: VoiceConfig }): Promise<Buffer> {
    const attempts = Math.max(1, Math.min(6, 1 + input.config.retryCount));
    const requestTimeoutMs = Math.max(3000, input.config.requestTimeoutMs);
    let lastError: Error | null = null;

    for (let index = 0; index < attempts; index += 1) {
      try {
        return await withTimeout(this.synthesizeOnce(input), requestTimeoutMs);
      } catch (error) {
        lastError = normalizeError(error);
        if (index >= attempts - 1) {
          break;
        }

        const backoffMs = 500 * (index + 1);
        await sleep(backoffMs);
      }
    }

    const message = `Edge TTS 合成失败（重试 ${attempts - 1} 次）：${lastError?.message ?? "未知错误"}`;
    throw new Error(message);
  }

  private async synthesizeOnce(input: { text: string; config: VoiceConfig }): Promise<Buffer> {
    const connectionTimeoutMs = Math.max(3000, Math.min(120_000, input.config.requestTimeoutMs));
    const ws = await createWebSocket({
      url: buildWebSocketUrl(),
      connectionTimeoutMs,
      headers: buildWebSocketHeaders()
    });
    const timestamp = formatUtcDateForEdge();
    const requestId = createConnectionId();

    return new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      const audioChunks: Buffer[] = [];

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

        if (audioChunks.length === 0) {
          reject(new Error("Edge TTS 未返回音频数据"));
          return;
        }

        const audio = Buffer.concat(audioChunks);
        if (audio.length === 0) {
          reject(new Error("Edge TTS 返回空音频"));
          return;
        }
        resolve(audio);
      };

      ws.on("unexpected-response", (_request, response) => {
        const statusCode =
          response && typeof response === "object" && "statusCode" in response
            ? String((response as { statusCode?: number }).statusCode ?? "unknown")
            : "unknown";
        const statusMessage =
          response && typeof response === "object" && "statusMessage" in response
            ? String((response as { statusMessage?: string }).statusMessage ?? "")
            : "";
        fail(new Error(`Edge TTS WebSocket 握手失败：${statusCode}${statusMessage ? ` ${statusMessage}` : ""}`));
      });

      ws.on("error", (error) => {
        fail(error);
      });

      ws.on("open", () => {
        try {
          ws.send(buildSpeechConfigFrame(timestamp));
          ws.send(
            buildSsmlFrame({
              requestId,
              timestamp,
              text: input.text,
              config: input.config
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

        try {
          if (isBinary) {
            const [headers, body] = splitBinaryFrame(toBuffer(raw));
            if (headers.Path === "audio" && headers["Content-Type"] === "audio/mpeg" && body.length > 0) {
              audioChunks.push(body);
            }
            return;
          }

          const textPayload = typeof raw === "string" ? raw : toBuffer(raw);
          const [headers] = splitTextFrame(textPayload);
          const framePath = headers.Path;
          if (framePath === "turn.end") {
            finish();
          }
        } catch (error) {
          fail(error);
        }
      });

      ws.on("close", () => {
        if (settled) {
          return;
        }

        if (audioChunks.length > 0) {
          finish();
          return;
        }

        fail(new Error("Edge TTS 连接关闭且未收到音频数据"));
      });
    });
  }
}
