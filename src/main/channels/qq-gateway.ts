import {
  QQ_INTENTS_C2C,
  QQ_OP,
  type QQC2CMessageEvent,
  type QQGatewayHelloData,
  type QQGatewayPayload,
  type QQGatewayReadyEvent
} from "./qq-types";
import type { QQAuthManager } from "./qq-auth";
import { appLogger as logger } from "@main/runtime/singletons";

const GATEWAY_ENDPOINT = "https://api.sgroup.qq.com/gateway";
const RECONNECT_DELAY_MS = 5_000;

interface WsLike {
  readyState: number;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, data?: string): void;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

interface GatewayOptions {
  auth: QQAuthManager;
  onC2CMessage: (event: QQC2CMessageEvent) => void | Promise<void>;
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
}

function toMessageText(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }

  if (payload instanceof Buffer) {
    return payload.toString("utf8");
  }

  if (payload instanceof ArrayBuffer) {
    return Buffer.from(payload).toString("utf8");
  }

  if (Array.isArray(payload)) {
    return Buffer.concat(payload.filter((item): item is Buffer => item instanceof Buffer)).toString(
      "utf8"
    );
  }

  return "";
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
    handshakeTimeout: 15_000,
    timeout: 30_000
  });
}

export class QQGateway {
  private socket: WsLike | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sequence: number | null = null;
  private sessionId = "";
  private connected = false;
  private destroyed = false;
  private shouldResume = false;
  private socketVersion = 0;
  private connecting: Promise<void> | null = null;

  constructor(private readonly opts: GatewayOptions) {}

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    if (this.connecting) {
      return this.connecting;
    }

    const connectTask = this.connectOnce();
    this.connecting = connectTask;

    try {
      await connectTask;
    } finally {
      if (this.connecting === connectTask) {
        this.connecting = null;
      }
    }
  }

  async disconnect(): Promise<void> {
    this.destroyed = true;
    this.connected = false;
    this.shouldResume = false;
    this.stopHeartbeat();
    this.clearReconnect();

    if (this.socket) {
      this.socketVersion += 1;
      const socket = this.socket;
      this.socket = null;
      try {
        socket.close(1000, "shutdown");
      } catch {
        // ignore
      }
    }
  }

  private async connectOnce(): Promise<void> {
    const version = ++this.socketVersion;
    this.stopHeartbeat();
    this.clearReconnect();

    try {
      const url = await this.fetchGatewayUrl();
      if (this.destroyed || version !== this.socketVersion) {
        return;
      }

      const socket = await createWebSocket(url);
      if (this.destroyed || version !== this.socketVersion) {
        socket.close(1000, "stale");
        return;
      }

      this.socket = socket;
      socket.on("message", (raw) => {
        if (version !== this.socketVersion || this.destroyed) {
          return;
        }
        this.handleRawMessage(raw);
      });

      socket.on("close", (code, reason) => {
        if (version !== this.socketVersion) {
          return;
        }
        this.socket = null;
        this.connected = false;
        this.stopHeartbeat();
        this.opts.onDisconnected?.(`WebSocket closed: ${code} ${reason.toString("utf8")}`);

        if (!this.destroyed) {
          this.scheduleReconnect();
        }
      });

      socket.on("error", (error) => {
        if (version !== this.socketVersion || this.destroyed) {
          return;
        }
        logger.warn("qq-gateway", "websocket-error", undefined, error);
      });
    } catch (error) {
      this.connected = false;
      this.opts.onDisconnected?.(
        `Gateway connect failed: ${error instanceof Error ? error.message : String(error)}`
      );
      this.scheduleReconnect();
      throw error;
    }
  }

  private async fetchGatewayUrl(): Promise<string> {
    const response = await fetch(GATEWAY_ENDPOINT, {
      headers: {
        Authorization: await this.opts.auth.authHeader()
      }
    });

    if (!response.ok) {
      throw new Error(`Gateway URL fetch failed: ${response.status}`);
    }

    const payload = (await response.json()) as {
      url?: string;
    };
    const url = payload.url?.trim();
    if (!url) {
      throw new Error("Gateway URL missing");
    }

    return url;
  }

  private handleRawMessage(raw: unknown): void {
    const text = toMessageText(raw);
    if (!text) {
      return;
    }

    let payload: QQGatewayPayload;
    try {
      payload = JSON.parse(text) as QQGatewayPayload;
    } catch {
      return;
    }

    void this.handlePayload(payload);
  }

  private async handlePayload(payload: QQGatewayPayload): Promise<void> {
    if (typeof payload.s === "number") {
      this.sequence = payload.s;
    }

    if (payload.op === QQ_OP.HELLO) {
      await this.onHello(payload.d);
      return;
    }

    if (payload.op === QQ_OP.DISPATCH) {
      this.onDispatch(payload);
      return;
    }

    if (payload.op === QQ_OP.RECONNECT) {
      await this.reconnect(true);
      return;
    }

    if (payload.op === QQ_OP.INVALID_SESSION) {
      this.sessionId = "";
      this.sequence = null;
      await this.reconnect(false);
    }
  }

  private async onHello(data: unknown): Promise<void> {
    const hello = (data ?? {}) as QQGatewayHelloData;
    const heartbeatIntervalMs =
      typeof hello.heartbeat_interval === "number" && hello.heartbeat_interval > 0
        ? hello.heartbeat_interval
        : 45_000;
    this.startHeartbeat(heartbeatIntervalMs);

    if (this.sessionId && this.shouldResume) {
      this.sendPayload({
        op: QQ_OP.RESUME,
        d: {
          token: await this.opts.auth.authHeader(),
          session_id: this.sessionId,
          seq: this.sequence
        }
      });
      this.shouldResume = false;
      return;
    }

    this.sendPayload({
      op: QQ_OP.IDENTIFY,
      d: {
        token: await this.opts.auth.authHeader(),
        intents: QQ_INTENTS_C2C,
        shard: [0, 1]
      }
    });
  }

  private onDispatch(payload: QQGatewayPayload): void {
    if (payload.t === "READY") {
      const ready = (payload.d ?? {}) as QQGatewayReadyEvent;
      if (typeof ready.session_id === "string" && ready.session_id.trim()) {
        this.sessionId = ready.session_id;
      }
      this.connected = true;
      this.opts.onConnected?.();
      return;
    }

    if (payload.t === "RESUMED") {
      this.connected = true;
      this.opts.onConnected?.();
      return;
    }

    if (payload.t === "C2C_MESSAGE_CREATE" && payload.d) {
      void Promise.resolve(this.opts.onC2CMessage(payload.d as QQC2CMessageEvent)).catch((error) => {
        logger.warn("qq-gateway", "message-handler-failed", undefined, error);
      });
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendPayload({
        op: QQ_OP.HEARTBEAT,
        d: this.sequence
      });
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return;
    }

    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private sendPayload(payload: QQGatewayPayload): void {
    if (!this.socket || this.socket.readyState !== 1) {
      return;
    }

    this.socket.send(JSON.stringify(payload));
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect(Boolean(this.sessionId));
    }, RECONNECT_DELAY_MS);
    this.reconnectTimer.unref?.();
  }

  private clearReconnect(): void {
    if (!this.reconnectTimer) {
      return;
    }

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async reconnect(resume: boolean): Promise<void> {
    if (this.destroyed) {
      return;
    }

    this.connected = false;
    this.shouldResume = resume && Boolean(this.sessionId);
    this.stopHeartbeat();
    this.clearReconnect();

    if (this.socket) {
      this.socketVersion += 1;
      const socket = this.socket;
      this.socket = null;
      try {
        socket.close(4000, "reconnect");
      } catch {
        // ignore
      }
    }

    try {
      await this.connect();
    } catch {
      // reconnect scheduling handled in connectOnce
    }
  }
}
