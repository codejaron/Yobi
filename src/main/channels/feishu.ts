import * as lark from "@larksuiteoapi/node-sdk";
import type { AppConfig } from "@shared/types";
import type { ChatChannel, InboundMessage, OutboundMessage } from "./types";
import { appLogger as logger } from "@main/runtime/singletons";
import { FeishuStreamingSession } from "./feishu-streaming";

interface FeishuEventPayload {
  event_id?: string;
  sender?: {
    sender_id?: {
      open_id?: string;
    };
  };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    create_time?: string;
  };
}

const INBOUND_DEDUP_TTL_MS = 10 * 60_000;
const CLEANUP_INTERVAL_MS = 60_000;

function parseFeishuTimestamp(raw: string | undefined): string {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return new Date().toISOString();
  }
  const ms = parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
  return new Date(ms).toISOString();
}

export class FeishuChannel implements ChatChannel {
  private client: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;
  private connected = false;
  private appId = "";
  private appSecret = "";
  private streamingSession: FeishuStreamingSession | null = null;
  private readonly recentInboundIds = new Map<string, number>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly getConfig: () => AppConfig) {}

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    const { feishu } = this.getConfig();
    if (!feishu.enabled || !feishu.appId.trim() || !feishu.appSecret.trim()) {
      this.stopCleanupLoop();
      this.recentInboundIds.clear();
      this.streamingSession = null;
      this.appId = "";
      this.appSecret = "";
      this.connected = false;
      this.client = null;
      this.wsClient = null;
      return;
    }

    this.connected = false;
    this.appId = feishu.appId.trim();
    this.appSecret = feishu.appSecret.trim();
    try {
      this.wsClient?.close();
    } catch (error) {
      logger.warn("feishu", "ws-close-before-start-failed", undefined, error);
    }
    this.wsClient = null;
    this.startCleanupLoop();

    this.client = new lark.Client({
      appId: feishu.appId.trim(),
      appSecret: feishu.appSecret.trim(),
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.warn
    });

    const eventDispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: FeishuEventPayload) => {
        try {
          await this.handleIncomingMessage(data, onMessage);
        } catch (error) {
          logger.error("feishu", "inbound-handler-error", undefined, error);
        }
      }
    });

    const wsClient = new lark.WSClient({
      appId: feishu.appId.trim(),
      appSecret: feishu.appSecret.trim(),
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.warn
    });

    try {
      await wsClient.start({ eventDispatcher });
      this.wsClient = wsClient;
      this.connected = true;
      logger.info("feishu", "ws-connected");
    } catch (error) {
      this.wsClient = null;
      this.connected = false;
      logger.error("feishu", "ws-connect-failed", undefined, error);
    }
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.client) {
      return;
    }

    const resolvedChatId = typeof message.chatId === "string" ? message.chatId.trim() : "";

    if (!resolvedChatId) {
      return;
    }

    try {
      if (message.kind === "text") {
        await this.client.im.message.create({
          params: {
            receive_id_type: "chat_id"
          },
          data: {
            receive_id: resolvedChatId,
            msg_type: "text",
            content: JSON.stringify({ text: message.text })
          }
        });
        return;
      }

      if (message.kind === "photo") {
        const caption = message.caption?.trim() ?? "";
        const url = message.photoUrl?.trim() || message.photoPath?.trim() || "";
        if (!url && !caption) {
          return;
        }
        const text = caption && url ? `${caption}\n${url}` : caption || url;
        await this.client.im.message.create({
          params: {
            receive_id_type: "chat_id"
          },
          data: {
            receive_id: resolvedChatId,
            msg_type: "text",
            content: JSON.stringify({ text })
          }
        });
        return;
      }

      const text = message.caption?.trim() || "[语音消息]";
      await this.client.im.message.create({
        params: {
          receive_id_type: "chat_id"
        },
        data: {
          receive_id: resolvedChatId,
          msg_type: "text",
          content: JSON.stringify({ text })
        }
      });
    } catch (error) {
      logger.error("feishu", "send-message-failed", undefined, error);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async stop(): Promise<void> {
    this.stopCleanupLoop();
    try {
      this.wsClient?.close();
    } catch (error) {
      logger.warn("feishu", "ws-close-failed", undefined, error);
    }
    this.wsClient = null;
    this.client = null;
    this.connected = false;
    this.streamingSession = null;
    this.appId = "";
    this.appSecret = "";
    this.recentInboundIds.clear();
  }

  async startStreaming(chatId: string): Promise<void> {
    if (!this.client) {
      return;
    }

    const resolvedChatId = chatId.trim();
    if (!resolvedChatId || !this.appId || !this.appSecret) {
      return;
    }

    if (this.streamingSession?.isActive()) {
      await this.streamingSession.close().catch(() => undefined);
    }

    const session = new FeishuStreamingSession(this.client, {
      appId: this.appId,
      appSecret: this.appSecret
    });
    await session.start(resolvedChatId);
    this.streamingSession = session;
  }

  async pushStreamingDelta(fullText: string): Promise<void> {
    await this.streamingSession?.update(fullText);
  }

  async finishStreaming(finalText: string): Promise<void> {
    if (!this.streamingSession) {
      return;
    }

    const session = this.streamingSession;
    this.streamingSession = null;
    await session.close(finalText);
  }

  private async handleIncomingMessage(
    data: FeishuEventPayload,
    onMessage: (message: InboundMessage) => Promise<void>
  ): Promise<void> {
    const message = data.message;
    if (!message) {
      return;
    }

    const chatId = message.chat_id?.trim() ?? "";
    const chatType = message.chat_type ?? "";
    const senderId = data.sender?.sender_id?.open_id?.trim() || "unknown";
    const messageType = message.message_type ?? "";
    if (!chatId) {
      return;
    }

    const dedupeKey = message.message_id?.trim() || data.event_id?.trim() || "";
    if (dedupeKey && this.isDuplicateInbound(dedupeKey)) {
      return;
    }

    if (chatType !== "p2p") {
      return;
    }

    let text = "";
    let photoUrl: string | undefined;
    let kind: "text" | "photo" = "text";
    try {
      const content = JSON.parse(message.content ?? "{}") as Record<string, unknown>;

      if (messageType === "text") {
        const rawText = typeof content.text === "string" ? content.text : "";
        text = rawText.trim();
      } else if (messageType === "image") {
        kind = "photo";
        text = "用户发送了一张图片";
        if (typeof content.image_key === "string" && content.image_key.trim()) {
          photoUrl = content.image_key.trim();
        }
      } else if (messageType === "post") {
        text = this.extractPostText(content);
      } else {
        text = `[不支持的消息类型: ${messageType}]`;
      }
    } catch {
      text = "[消息解析失败]";
    }

    if (!text && !photoUrl) {
      return;
    }

    await onMessage({
      kind,
      chatId,
      text,
      fromUserId: senderId,
      sentAt: parseFeishuTimestamp(message.create_time),
      photoUrl
    });
  }

  private startCleanupLoop(): void {
    this.stopCleanupLoop();
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, expiresAt] of this.recentInboundIds.entries()) {
        if (expiresAt <= now) {
          this.recentInboundIds.delete(id);
        }
      }
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  private stopCleanupLoop(): void {
    if (!this.cleanupTimer) {
      return;
    }
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  private isDuplicateInbound(id: string): boolean {
    const now = Date.now();
    const expiresAt = this.recentInboundIds.get(id);
    if (expiresAt && expiresAt > now) {
      return true;
    }
    this.recentInboundIds.set(id, now + INBOUND_DEDUP_TTL_MS);
    return false;
  }

  private extractPostText(rawContent: Record<string, unknown>): string {
    const nested =
      rawContent.zh_cn && typeof rawContent.zh_cn === "object"
        ? (rawContent.zh_cn as Record<string, unknown>)
        : rawContent;
    const parts: string[] = [];
    if (typeof nested.title === "string" && nested.title.trim()) {
      parts.push(nested.title.trim());
    }

    const lines = Array.isArray(nested.content) ? nested.content : [];
    for (const line of lines) {
      if (!Array.isArray(line)) {
        continue;
      }
      for (const item of line) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const row = item as { tag?: string; text?: string };
        if ((row.tag === "text" || row.tag === "a") && typeof row.text === "string" && row.text.trim()) {
          parts.push(row.text.trim());
        }
      }
    }

    return parts.join(" ").replace(/\s+/g, " ").trim();
  }
}
