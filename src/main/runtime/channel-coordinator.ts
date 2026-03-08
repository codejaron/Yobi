import type { InboundMessage } from "@main/channels/types";
import { TelegramChannel } from "@main/channels/telegram";
import { QQChannel } from "@main/channels/qq";
import { FeishuChannel } from "@main/channels/feishu";
import type { QQChannelConfig } from "@main/channels/qq-types";
import { extractEmotionTag } from "@main/core/emotion-tags";
import { AppLogger } from "@main/services/logger";
import type { PetWindowController } from "@main/pet/pet-window";
import type { RuntimeInboundChannel } from "@main/storage/runtime-context-store";

interface ChannelCoordinatorInput {
  telegram: TelegramChannel;
  feishu: FeishuChannel;
  createQQChannel: (config: QQChannelConfig) => QQChannel;
  logger: AppLogger;
  pet: PetWindowController;
  getQQConfig: () => QQChannelConfig;
  handleTelegram: (payload: {
    text: string;
    photoUrl?: string;
    resourceId: string;
    threadId: string;
  }) => Promise<string>;
  handleQQ: (payload: {
    text: string;
    photoUrl?: string;
    resourceId: string;
    threadId: string;
  }) => Promise<string>;
  handleFeishu: (payload: {
    text: string;
    photoUrl?: string;
    resourceId: string;
    threadId: string;
  }) => Promise<string>;
  onRecordUserActivity: (input: {
    channel: RuntimeInboundChannel;
    chatId?: string;
    text?: string;
  }) => Promise<void>;
  onAssistantMessage: () => Promise<void>;
  emitStatus: () => Promise<void>;
  withTimeout: <T>(promise: Promise<T>, timeoutMs: number, label: string) => Promise<T>;
  chatReplyTimeoutMs: number;
  resourceId: string;
  threadId: string;
}

export class ChannelCoordinator {
  private qqChannel: QQChannel | null = null;

  constructor(private readonly input: ChannelCoordinatorInput) {}

  getTelegramChannel(): TelegramChannel {
    return this.input.telegram;
  }

  getQQChannel(): QQChannel | null {
    return this.qqChannel;
  }

  getFeishuChannel(): FeishuChannel {
    return this.input.feishu;
  }

  isQQConnected(): boolean {
    return this.qqChannel?.isConnected() ?? false;
  }

  async startTelegram(): Promise<void> {
    await this.input.telegram.start(async (inbound) => {
      try {
        await this.handleInboundMessage({
          channel: "telegram",
          inbound,
          handle: (payload) => this.input.handleTelegram(payload),
          sendReply: async (text, chatId) => {
            await this.input.telegram.send({ kind: "text", text, chatId });
          }
        });
      } catch (error) {
        this.input.logger.error("runtime", "telegram:inbound-failed", undefined, error);
        const message = error instanceof Error ? `处理消息时出错：${error.message}` : "处理消息时出现未知错误。";
        await this.input.telegram.send({ kind: "text", text: message, chatId: inbound.chatId });
      }
      await this.input.emitStatus();
    });
  }

  async restartTelegram(): Promise<void> {
    await this.input.telegram.stop();
    await this.startTelegram();
  }

  async startFeishu(): Promise<void> {
    await this.input.feishu.start(async (inbound) => {
      try {
        await this.handleInboundMessage({
          channel: "feishu",
          inbound,
          handle: (payload) => this.input.handleFeishu(payload),
          sendReply: async (text, chatId) => {
            await this.input.feishu.send({ kind: "text", text, chatId });
          }
        });
      } catch (error) {
        this.input.logger.error("runtime", "feishu:inbound-failed", undefined, error);
        const message = error instanceof Error ? `处理消息时出错：${error.message}` : "处理消息时出现未知错误。";
        await this.input.feishu.send({ kind: "text", text: message, chatId: inbound.chatId });
      }
      await this.input.emitStatus();
    });
  }

  async restartFeishu(): Promise<void> {
    await this.input.feishu.stop();
    await this.startFeishu();
  }

  async startQQ(): Promise<void> {
    const config = this.input.getQQConfig();
    if (!config.enabled || !config.appId.trim() || !config.appSecret.trim()) {
      await this.stopQQ();
      return;
    }

    await this.stopQQ();
    this.qqChannel = this.input.createQQChannel(config);
    await this.qqChannel.start(async (inbound) => {
      try {
        await this.handleInboundMessage({
          channel: "qq",
          inbound,
          handle: (payload) => this.input.handleQQ(payload),
          sendReply: async (text, chatId) => {
            await this.qqChannel?.send({ kind: "text", text, chatId });
          }
        });
      } catch (error) {
        this.input.logger.error("runtime", "qq:inbound-failed", undefined, error);
        const message = error instanceof Error ? `处理消息时出错：${error.message}` : "处理消息时出现未知错误。";
        await this.qqChannel?.send({ kind: "text", text: message, chatId: inbound.chatId });
      }
      await this.input.emitStatus();
    });
  }

  async restartQQ(): Promise<void> {
    await this.stopQQ();
    await this.startQQ();
  }

  async stopQQ(): Promise<void> {
    if (!this.qqChannel) {
      return;
    }
    await this.qqChannel.stop();
    this.qqChannel = null;
  }

  async stopFeishu(): Promise<void> {
    await this.input.feishu.stop();
  }

  private async handleInboundMessage(input: {
    channel: "telegram" | "qq" | "feishu";
    inbound: InboundMessage;
    handle: (payload: {
      text: string;
      photoUrl?: string;
      resourceId: string;
      threadId: string;
    }) => Promise<string>;
    sendReply: (text: string, chatId: string) => Promise<void>;
  }): Promise<void> {
    this.input.pet.emitEvent({ type: "thinking", value: "start" });
    await this.input.onRecordUserActivity({
      channel: input.channel,
      chatId: input.inbound.chatId,
      text: input.inbound.text
    });

    try {
      const reply = await this.input.withTimeout(
        input.handle({
          text: input.inbound.text,
          photoUrl: input.inbound.photoUrl,
          resourceId: this.input.resourceId,
          threadId: this.input.threadId
        }),
        this.input.chatReplyTimeoutMs,
        "LLM 回复超时"
      );
      const parsedReply = extractEmotionTag(reply);
      const visibleReply = parsedReply.cleanedText.trim();

      if (parsedReply.emotion) {
        this.input.pet.emitEvent({ type: "emotion", value: parsedReply.emotion });
      }

      if (visibleReply) {
        await input.sendReply(visibleReply, input.inbound.chatId);
        await this.input.onAssistantMessage();
      }
    } finally {
      this.input.pet.emitEvent({ type: "thinking", value: "stop" });
    }
  }
}
