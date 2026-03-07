import type { ChatChannel, InboundMessage, OutboundMessage } from "./types";
import type { QQC2CMessageEvent, QQChannelConfig, QQSendC2CMessageBody } from "./qq-types";
import { QQAuthManager } from "./qq-auth";
import { QQGateway } from "./qq-gateway";
import { CompanionPaths } from "@main/storage/paths";
import { AppLogger } from "@main/services/logger";
const logger = new AppLogger(new CompanionPaths());

const API_BASE = "https://api.sgroup.qq.com";
const REPLY_WINDOW_TTL_MS = 55 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60_000;

interface ReplyWindow {
  msgId: string;
  expiresAt: number;
  nextSeq: number;
}

export class QQChannel implements ChatChannel {
  private readonly auth: QQAuthManager;
  private readonly gateway: QQGateway;
  private readonly apiBase: string;

  private readonly replyWindows = new Map<string, ReplyWindow>();
  private readonly recentMsgIds = new Set<string>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private onMessage: ((message: InboundMessage) => Promise<void>) | null = null;

  constructor(config: QQChannelConfig) {
    this.auth = new QQAuthManager(config.appId, config.appSecret);
    this.apiBase = API_BASE;
    this.gateway = new QQGateway({
      auth: this.auth,
      onC2CMessage: (event) => this.handleC2CMessage(event),
      onConnected: () => {
        logger.info("qq", "gateway-connected");
      },
      onDisconnected: (reason) => {
        logger.warn("qq", "gateway-disconnected", { reason });
      }
    });
  }

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.onMessage = onMessage;
    this.startCleanupLoop();
    await this.gateway.connect().catch((error) => {
      logger.warn("qq", "initial-connect-failed", undefined, error);
    });
  }

  async send(message: OutboundMessage): Promise<void> {
    if (message.kind !== "text") {
      return;
    }

    const chatId = typeof message.chatId === "string" ? message.chatId.trim() : "";
    if (!chatId) {
      return;
    }

    const window = this.replyWindows.get(chatId);
    if (!window || Date.now() > window.expiresAt) {
      logger.warn("qq", "missing-passive-reply-window", { chatId });
      return;
    }

    const body: QQSendC2CMessageBody = {
      content: message.text,
      msg_type: 0,
      msg_id: window.msgId,
      msg_seq: window.nextSeq
    };
    window.nextSeq += 1;

    const response = await fetch(`${this.apiBase}/v2/users/${encodeURIComponent(chatId)}/messages`, {
      method: "POST",
      headers: {
        Authorization: await this.auth.authHeader(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const detail = await response.text();
      logger.error("qq", "send-message-failed", { status: response.status, detail });
    }
  }

  isConnected(): boolean {
    return this.gateway.isConnected;
  }

  async stop(): Promise<void> {
    this.stopCleanupLoop();
    await this.gateway.disconnect();
    this.auth.dispose();
    this.replyWindows.clear();
    this.recentMsgIds.clear();
    this.onMessage = null;
  }

  private startCleanupLoop(): void {
    this.stopCleanupLoop();

    this.cleanupTimer = setInterval(() => {
      this.recentMsgIds.clear();
      const now = Date.now();
      for (const [chatId, window] of this.replyWindows.entries()) {
        if (window.expiresAt <= now) {
          this.replyWindows.delete(chatId);
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

  private async handleC2CMessage(event: QQC2CMessageEvent): Promise<void> {
    if (this.recentMsgIds.has(event.id)) {
      return;
    }
    this.recentMsgIds.add(event.id);

    const openid = event.author?.user_openid?.trim();
    if (!openid) {
      return;
    }

    this.replyWindows.set(openid, {
      msgId: event.id,
      expiresAt: Date.now() + REPLY_WINDOW_TTL_MS,
      nextSeq: 1
    });

    const imageAttachment = event.attachments?.find(
      (item) => typeof item.content_type === "string" && item.content_type.startsWith("image/")
    );
    const hasImage = Boolean(imageAttachment?.url);
    const normalizedText = event.content?.trim() ?? "";
    const fallbackText = hasImage ? "用户发送了一张图片" : "";
    const text = normalizedText || fallbackText;
    if (!text && !hasImage) {
      return;
    }

    const inbound: InboundMessage = {
      kind: hasImage ? "photo" : "text",
      chatId: openid,
      text,
      fromUserId: openid,
      sentAt: event.timestamp || new Date().toISOString(),
      photoUrl: imageAttachment?.url
    };

    if (!this.onMessage) {
      return;
    }

    await this.onMessage(inbound);
  }
}
