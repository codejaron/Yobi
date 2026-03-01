import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AppConfig } from "@shared/types";
import {
  isClawResponseOk,
  isConnectChallengeEvent,
  parseClawFrame,
  stringifyClawFrame,
  summarizeClawError,
  type ClawEventFrame,
  type ClawReqFrame,
  type ClawResFrame
} from "./protocol";
import { isRecord, summarizeUnknown } from "@main/utils/guards";

const CONNECT_TIMEOUT_MS = 12_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const CONNECT_CHALLENGE_WAIT_MS = 5_000;
const CLIENT_ID = "gateway-client";
const CLIENT_MODE = "backend";
const CLIENT_CAP_TOOL_EVENTS = "tool-events";

interface WsLike {
  readyState: number;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, data?: string): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: string | Buffer) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type ClawConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected-manual";

function toMessageText(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }

  if (payload instanceof Buffer) {
    return payload.toString("utf8");
  }
 
  return "";
}

function normalizeGatewayWsUrl(gatewayUrl: string): string {
  const trimmed = gatewayUrl.trim();
  const parsed = new URL(trimmed);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";

  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (!pathname || pathname === "") {
    parsed.pathname = "/ws";
  } else if (pathname === "/") {
    parsed.pathname = "/ws";
  } else if (pathname.endsWith("/ws")) {
    parsed.pathname = pathname;
  } else {
    parsed.pathname = `${pathname}/ws`;
  }

  parsed.search = "";
  parsed.hash = "";

  return parsed.toString();
}

async function createWebSocket(url: string): Promise<WsLike> {
  const dynamicImport = new Function("moduleName", "return import(moduleName);") as (
    moduleName: string
  ) => Promise<unknown>;

  const wsModule = await dynamicImport("ws");
  const WebSocketCtor =
    (wsModule as { default?: new (url: string, options?: unknown) => WsLike }).default ??
    (wsModule as unknown as new (url: string, options?: unknown) => WsLike);

  return new WebSocketCtor(url, {
    handshakeTimeout: CONNECT_TIMEOUT_MS,
    timeout: REQUEST_TIMEOUT_MS
  });
}

function resolveClientPlatform(): string {
  return process.platform;
}

function extractNonce(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  const nonce = "nonce" in payload ? (payload as { nonce?: unknown }).nonce : undefined;
  if (typeof nonce !== "string") {
    return null;
  }

  const normalized = nonce.trim();
  return normalized || null;
}

function isHelloOkPayload(payload: unknown): payload is { type: "hello-ok"; protocol?: number } {
  if (!isRecord(payload)) {
    return false;
  }

  if (payload.type !== "hello-ok") {
    return false;
  }

  if ("protocol" in payload && typeof payload.protocol !== "number") {
    return false;
  }

  return true;
}

export class ClawClient {
  private readonly emitter = new EventEmitter();
  private readonly pendingRequests = new Map<string, PendingRequest>();

  private socket: WsLike | null = null;
  private connectionState: ClawConnectionState = "idle";
  private connectionMessage = "未连接";
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private manualDisconnect = false;
  private connectedUrl = "";

  constructor(
    private readonly getConfig: () => AppConfig,
    private readonly getAuthToken: () => string
  ) {}

  getState(): ClawConnectionState {
    return this.connectionState;
  }

  getConnectionStatus(): {
    state: ClawConnectionState;
    message: string;
  } {
    return {
      state: this.connectionState,
      message: this.connectionMessage
    };
  }

  onConnection(listener: (state: ClawConnectionState, message: string) => void): () => void {
    this.emitter.on("connection", listener);
    return () => {
      this.emitter.off("connection", listener);
    };
  }

  onEvent(listener: (frame: ClawEventFrame) => void): () => void {
    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }

  onError(listener: (error: Error) => void): () => void {
    this.emitter.on("error", listener);
    return () => {
      this.emitter.off("error", listener);
    };
  }

  async connect(input?: { manual?: boolean }): Promise<void> {
    if (input?.manual) {
      this.manualDisconnect = false;
    }

    if (this.connectionState === "connected") {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    const token = this.getAuthToken().trim();
    if (!token) {
      throw new Error("Claw 认证 token 不可用，请先启动 OpenClaw Gateway。");
    }

    this.setConnectionState(this.connectionState === "reconnecting" ? "reconnecting" : "connecting", "正在连接 Claw Gateway...");

    const connectTask = this.establishConnection(token)
      .then(() => {
        this.reconnectAttempt = 0;
      })
      .catch((error) => {
        const normalized = error instanceof Error ? error : new Error(summarizeUnknown(error));
        this.emitter.emit("error", normalized);
        if (this.manualDisconnect) {
          this.setConnectionState("disconnected-manual", "已手动断开");
        } else {
          this.scheduleReconnect();
        }
        throw normalized;
      })
      .finally(() => {
        this.connectPromise = null;
      });

    this.connectPromise = connectTask;
    return connectTask;
  }

  async disconnect(input?: { manual?: boolean }): Promise<void> {
    const manual = input?.manual ?? true;
    this.manualDisconnect = manual;
    this.clearReconnectTimer();

    const socket = this.socket;
    this.socket = null;

    if (socket) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          resolve();
        };

        const timer = setTimeout(() => {
          finish();
        }, 500);

        socket.on("close", () => {
          clearTimeout(timer);
          finish();
        });

        try {
          socket.close(1000, manual ? "manual-disconnect" : "disconnect");
        } catch {
          clearTimeout(timer);
          finish();
        }
      });
    }

    this.rejectPendingRequests("连接已断开");
    this.setConnectionState(manual ? "disconnected-manual" : "idle", manual ? "已手动断开" : "已断开");
  }

  async send(sessionKey: string, message: string): Promise<unknown> {
    await this.connect();
    return this.sendRequest("chat.send", {
      sessionKey,
      message,
      idempotencyKey: randomUUID()
    });
  }

  async getHistory(sessionKey: string, limit = 50): Promise<unknown> {
    await this.connect();
    return this.sendRequest("chat.history", {
      sessionKey,
      limit
    });
  }

  async abort(sessionKey: string): Promise<unknown> {
    await this.connect();
    return this.sendRequest("chat.abort", {
      sessionKey
    });
  }

  private async establishConnection(token: string): Promise<void> {
    const wsUrl = normalizeGatewayWsUrl(this.getConfig().openclaw.gatewayUrl);
    const socket = await createWebSocket(wsUrl);

    this.socket = socket;
    this.connectedUrl = wsUrl;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let connectStarted = false;
      let challengeTimer: ReturnType<typeof setTimeout> | null = null;

      const settleResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (challengeTimer) {
          clearTimeout(challengeTimer);
          challengeTimer = null;
        }
        this.setConnectionState("connected", `已连接 ${this.connectedUrl}`);
        resolve();
      };

      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (challengeTimer) {
          clearTimeout(challengeTimer);
          challengeTimer = null;
        }

        if (this.socket === socket) {
          this.socket = null;
        }

        this.rejectPendingRequests(error.message || "连接失败");
        reject(error);
      };

      const beginConnect = () => {
        if (connectStarted || settled) {
          return;
        }

        connectStarted = true;
        const params: Record<string, unknown> = {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: CLIENT_ID,
            displayName: "Yobi",
            platform: resolveClientPlatform(),
            mode: CLIENT_MODE,
            version: "0.1.0"
          },
          role: "operator",
          scopes: ["operator.admin"],
          caps: [CLIENT_CAP_TOOL_EVENTS],
          commands: [],
          auth: {
            token
          }
        };

        void this.sendRequest("connect", params, {
          timeoutMs: CONNECT_TIMEOUT_MS,
          allowBeforeConnected: true
        })
          .then((result) => {
            if (!isHelloOkPayload(result)) {
              throw new Error("connect 握手响应无效");
            }

            if (typeof result.protocol === "number" && result.protocol !== 3) {
              throw new Error(`connect 协议版本不匹配：${result.protocol}`);
            }

            settleResolve();
          })
          .catch((error) => {
            const normalized = error instanceof Error ? error : new Error(summarizeUnknown(error));
            settleReject(normalized);
            try {
              socket.close(4001, "connect-failed");
            } catch {
              // noop
            }
          });
      };

      socket.on("open", () => {
        if (settled) {
          return;
        }

        challengeTimer = setTimeout(() => {
          settleReject(new Error("未收到 connect.challenge，握手超时"));
          try {
            socket.close(4001, "connect-challenge-timeout");
          } catch {
            // noop
          }
        }, CONNECT_CHALLENGE_WAIT_MS);
      });

      socket.on("message", (data) => {
        const text = toMessageText(data);
        if (!text) {
          return;
        }

        const frame = parseClawFrame(text);
        if (!frame) {
          return;
        }

        if (frame.type === "res") {
          this.resolvePendingRequest(frame);
          return;
        }

        if (frame.type === "event") {
          this.emitter.emit("event", frame);
          if (isConnectChallengeEvent(frame)) {
            const nonce = extractNonce(frame.payload);
            if (!nonce) {
              settleReject(new Error("connect.challenge 缺少 nonce"));
              try {
                socket.close(4001, "connect-challenge-missing-nonce");
              } catch {
                // noop
              }
              return;
            }

            beginConnect();
          }
        }
      });

      socket.on("error", (error) => {
        this.emitter.emit("error", error);
        if (!settled) {
          settleReject(error);
        }
      });

      socket.on("close", (code, reasonBuffer) => {
        const reason = reasonBuffer?.toString("utf8") || "";
        if (!settled) {
          const message = reason
            ? `Claw Gateway 连接关闭（code=${code}, reason=${reason}）`
            : `Claw Gateway 连接关闭（code=${code}）`;
          settleReject(new Error(message));
          return;
        }

        if (this.socket === socket) {
          this.socket = null;
        }

        this.rejectPendingRequests("连接已断开");

        if (this.manualDisconnect) {
          this.setConnectionState("disconnected-manual", "已手动断开");
          return;
        }

        this.scheduleReconnect();
      });
    });
  }

  private sendRequest(
    method: string,
    params?: unknown,
    options?: {
      timeoutMs?: number;
      allowBeforeConnected?: boolean;
    }
  ): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      return Promise.reject(new Error("Claw Gateway 未连接"));
    }

    if (!options?.allowBeforeConnected && this.connectionState !== "connected") {
      return Promise.reject(new Error("Claw Gateway 正在连接，请稍后重试"));
    }

    const id = randomUUID();
    const frame: ClawReqFrame = {
      type: "req",
      id,
      method,
      params
    };

    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`请求超时：${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve,
        reject,
        timer
      });

      try {
        socket.send(stringifyClawFrame(frame), (error) => {
          if (!error) {
            return;
          }

          const pending = this.pendingRequests.get(id);
          if (!pending) {
            return;
          }

          clearTimeout(pending.timer);
          this.pendingRequests.delete(id);
          pending.reject(error);
        });
      } catch (error) {
        const pending = this.pendingRequests.get(id);
        if (!pending) {
          return;
        }

        clearTimeout(pending.timer);
        this.pendingRequests.delete(id);
        const normalized = error instanceof Error ? error : new Error(summarizeUnknown(error));
        pending.reject(normalized);
      }
    });
  }

  private resolvePendingRequest(frame: ClawResFrame): void {
    const pending = this.pendingRequests.get(frame.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(frame.id);

    if (isClawResponseOk(frame)) {
      pending.resolve(frame.result);
      return;
    }

    pending.reject(new Error(summarizeClawError(frame)));
  }

  private rejectPendingRequests(reason: string): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pendingRequests.delete(id);
    }
  }

  private scheduleReconnect(): void {
    if (this.manualDisconnect) {
      return;
    }

    if (this.reconnectTimer) {
      return;
    }

    const attempt = this.reconnectAttempt;
    const base = Math.min(MAX_RECONNECT_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** attempt);
    const jitter = Math.floor(base * Math.random() * 0.25);
    const delayMs = Math.min(MAX_RECONNECT_DELAY_MS, base + jitter);

    this.reconnectAttempt += 1;
    this.setConnectionState("reconnecting", `连接已断开，${Math.ceil(delayMs / 1000)} 秒后重连`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manualDisconnect) {
        return;
      }

      void this.connect()
        .catch((error) => {
          this.emitter.emit("error", error instanceof Error ? error : new Error(summarizeUnknown(error)));
          this.scheduleReconnect();
        });
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setConnectionState(state: ClawConnectionState, message: string): void {
    this.connectionState = state;
    this.connectionMessage = message;
    this.emitter.emit("connection", state, message);
  }
}
