import { Bot, InputFile } from "grammy";
import type { AppConfig } from "@shared/types";
import type { ChatChannel, InboundMessage, OutboundMessage } from "./types";
import { appLogger as logger } from "@main/runtime/singletons";

export class TelegramChannel implements ChatChannel {
  private bot: Bot | null = null;
  private connected = false;
  private targetChatId = "";

  constructor(private readonly getConfig: () => AppConfig) {}

  private shouldAcceptInboundChat(chatId: number): boolean {
    const expected = this.targetChatId;
    if (!expected) {
      return true;
    }

    if (/^-?\d+$/.test(expected)) {
      return String(chatId) === expected;
    }

    return true;
  }

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    const { telegram } = this.getConfig();
    const enabled = telegram.enabled;
    const botToken = telegram.botToken.trim();
    this.targetChatId = telegram.chatId.trim();

    if (!enabled || !botToken) {
      this.connected = false;
      this.bot = null;
      return;
    }

    this.bot = new Bot(botToken);
    this.bot.catch((error) => {
      logger.error("telegram", "middleware-error", undefined, error.error);
    });

    this.bot.on("message:text", async (ctx) => {
      if (!this.shouldAcceptInboundChat(ctx.chat.id)) {
        return;
      }

      await onMessage({
        kind: "text",
        chatId: String(ctx.chat.id),
        text: ctx.message.text,
        fromUserId: String(ctx.from?.id ?? "unknown"),
        sentAt: new Date(ctx.message.date * 1000).toISOString()
      });
    });

    this.bot.on("message:photo", async (ctx) => {
      if (!this.shouldAcceptInboundChat(ctx.chat.id)) {
        return;
      }

      const candidate = ctx.message.photo.at(-1);
      if (!candidate) {
        return;
      }

      const file = await ctx.api.getFile(candidate.file_id);
      const filePath = file.file_path;
      if (!filePath) {
        return;
      }

      const token = this.getConfig().telegram.botToken;
      const photoUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;

      await onMessage({
        kind: "photo",
        chatId: String(ctx.chat.id),
        text: ctx.message.caption ?? "用户发送了一张图片",
        fromUserId: String(ctx.from?.id ?? "unknown"),
        sentAt: new Date(ctx.message.date * 1000).toISOString(),
        photoUrl
      });
    });

    this.bot.start({
      onStart: () => {
        this.connected = true;
      },
      allowed_updates: ["message"]
    }).catch(() => {
      this.connected = false;
    });
  }

  async send(message: OutboundMessage): Promise<void> {
    const { telegram } = this.getConfig();
    const resolvedChatId =
      (typeof message.chatId === "string" ? message.chatId.trim() : "") || telegram.chatId.trim();

    if (!this.bot || !resolvedChatId) {
      return;
    }

    if (message.kind === "text") {
      await this.bot.api.sendMessage(resolvedChatId, message.text);
      return;
    }

    if (message.kind === "voice") {
      const filename = (message.filename ?? "voice.mp3").toLowerCase();
      const input = new InputFile(message.audio, filename);

      if (/\.(ogg|opus|mp3|m4a)$/.test(filename)) {
        await this.bot.api.sendVoice(resolvedChatId, input, {
          caption: message.caption
        });
        return;
      }

      await this.bot.api.sendAudio(resolvedChatId, input, {
        caption: message.caption
      });
      return;
    }

    if (message.photoUrl) {
      await this.bot.api.sendPhoto(resolvedChatId, message.photoUrl, {
        caption: message.caption
      });
      return;
    }

    if (message.photoPath) {
      await this.bot.api.sendPhoto(resolvedChatId, new InputFile(message.photoPath), {
        caption: message.caption
      });
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
    }
    this.bot = null;
    this.connected = false;
  }
}
