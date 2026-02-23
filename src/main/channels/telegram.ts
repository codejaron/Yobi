import { Bot, InputFile } from "grammy";
import type { AppConfig } from "@shared/types";
import type { ChatChannel, InboundMessage, OutboundMessage } from "./types";

export class TelegramChannel implements ChatChannel {
  private bot: Bot | null = null;
  private connected = false;
  private targetChatId = "";

  constructor(private readonly getConfig: () => AppConfig) {}

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    const { telegram } = this.getConfig();
    this.targetChatId = telegram.chatId;

    if (!telegram.botToken) {
      this.connected = false;
      return;
    }

    this.bot = new Bot(telegram.botToken);
    this.bot.catch((error) => {
      console.error("Telegram bot middleware error:", error.error);
    });

    this.bot.on("message:text", async (ctx) => {
      const expected = this.targetChatId;
      if (expected && String(ctx.chat.id) !== expected) {
        return;
      }

      await onMessage({
        kind: "text",
        text: ctx.message.text,
        fromUserId: String(ctx.from?.id ?? "unknown"),
        sentAt: new Date(ctx.message.date * 1000).toISOString()
      });
    });

    this.bot.on("message:photo", async (ctx) => {
      const expected = this.targetChatId;
      if (expected && String(ctx.chat.id) !== expected) {
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
    if (!this.bot || !telegram.chatId) {
      return;
    }

    if (message.kind === "text") {
      await this.bot.api.sendMessage(telegram.chatId, message.text);
      return;
    }

    if (message.kind === "voice") {
      const filename = (message.filename ?? "voice.mp3").toLowerCase();
      const input = new InputFile(message.audio, filename);

      if (/\.(ogg|opus|mp3|m4a)$/.test(filename)) {
        await this.bot.api.sendVoice(telegram.chatId, input, {
          caption: message.caption
        });
        return;
      }

      await this.bot.api.sendAudio(telegram.chatId, input, {
        caption: message.caption
      });
      return;
    }

    if (message.photoUrl) {
      await this.bot.api.sendPhoto(telegram.chatId, message.photoUrl, {
        caption: message.caption
      });
      return;
    }

    if (message.photoPath) {
      await this.bot.api.sendPhoto(telegram.chatId, new InputFile(message.photoPath), {
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
