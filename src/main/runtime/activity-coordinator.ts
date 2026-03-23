import type { AppConfig } from "@shared/types";
import { AppLogger } from "@main/services/logger";
import {
  RuntimeContextStore,
  type RuntimeContextStoreDocument,
  type RuntimeInboundChannel
} from "@main/storage/runtime-context-store";

export interface ActivityCoordinatorState {
  lastUserAt: string | null;
  lastProactiveAt: string | null;
  lastInboundChannel: RuntimeInboundChannel | null;
  lastInboundChatId: string | null;
  lastTelegramChatId: string | null;
  lastFeishuChatId: string | null;
  lastQQChatId: string | null;
}

interface ActivityCoordinatorInput {
  runtimeContextStore: RuntimeContextStore;
  logger: AppLogger;
  getConfig: () => AppConfig;
  onLastUserLoaded: (value: string | null) => void;
  onUserMessage: (input: { ts: string; text?: string }) => Promise<void>;
  sendTelegram: (text: string, chatId: string) => Promise<void>;
  sendFeishu: (text: string, chatId: string) => Promise<void>;
}

export class RuntimeActivityCoordinator {
  private state: ActivityCoordinatorState = {
    lastUserAt: null,
    lastProactiveAt: null,
    lastInboundChannel: null,
    lastInboundChatId: null,
    lastTelegramChatId: null,
    lastFeishuChatId: null,
    lastQQChatId: null
  };

  constructor(private readonly input: ActivityCoordinatorInput) {}

  load(): void {
    const context = this.input.runtimeContextStore.getContext();
    this.state = {
      lastUserAt: context.lastUserAt,
      lastProactiveAt: context.lastProactiveAt,
      lastInboundChannel: context.lastInboundChannel,
      lastInboundChatId: context.lastInboundChatId,
      lastTelegramChatId: context.lastTelegramChatId,
      lastFeishuChatId: context.lastFeishuChatId,
      lastQQChatId: context.lastQQChatId
    };
    this.input.onLastUserLoaded(this.state.lastUserAt);
  }

  getSnapshot(): ActivityCoordinatorState {
    return {
      ...this.state
    };
  }

  async recordUserActivity(input: {
    channel: RuntimeInboundChannel;
    chatId?: string;
    text?: string;
  }): Promise<void> {
    this.state.lastUserAt = new Date().toISOString();
    this.state.lastInboundChannel = input.channel;
    this.state.lastInboundChatId = input.chatId?.trim() ? input.chatId.trim() : null;
    if (input.channel === "telegram" && this.state.lastInboundChatId) {
      this.state.lastTelegramChatId = this.state.lastInboundChatId;
    }
    if (input.channel === "feishu" && this.state.lastInboundChatId) {
      this.state.lastFeishuChatId = this.state.lastInboundChatId;
    }
    if (input.channel === "qq" && this.state.lastInboundChatId) {
      this.state.lastQQChatId = this.state.lastInboundChatId;
    }
    await this.persist();
    await this.input.onUserMessage({
      ts: this.state.lastUserAt,
      text: input.text
    });
  }

  async recordProactiveActivity(): Promise<void> {
    this.state.lastProactiveAt = new Date().toISOString();
    await this.persist();
  }

  async pushToConfiguredChannels(
    text: string,
    targets: {
      telegram: boolean;
      feishu: boolean;
    }
  ): Promise<void> {
    if (targets.telegram) {
      const configuredChatId = this.input.getConfig().telegram.chatId.trim();
      const targetChatId = this.state.lastTelegramChatId ?? configuredChatId;
      if (targetChatId) {
        try {
          await this.input.sendTelegram(text, targetChatId);
        } catch (error) {
          this.input.logger.warn("kernel", "proactive:telegram-push-failed", undefined, error);
        }
      }
    }

    if (targets.feishu) {
      const targetChatId = this.state.lastFeishuChatId?.trim();
      if (!targetChatId) {
        return;
      }
      try {
        await this.input.sendFeishu(text, targetChatId);
      } catch (error) {
        this.input.logger.warn("kernel", "proactive:feishu-push-failed", undefined, error);
      }
    }
  }

  private async persist(): Promise<RuntimeContextStoreDocument | null> {
    try {
      return await this.input.runtimeContextStore.saveContext({
        lastProactiveAt: this.state.lastProactiveAt,
        lastUserAt: this.state.lastUserAt,
        lastInboundChannel: this.state.lastInboundChannel,
        lastInboundChatId: this.state.lastInboundChatId,
        lastTelegramChatId: this.state.lastTelegramChatId,
        lastFeishuChatId: this.state.lastFeishuChatId,
        lastQQChatId: this.state.lastQQChatId
      });
    } catch (error) {
      this.input.logger.warn("runtime", "persist-runtime-context-failed", undefined, error);
      return null;
    }
  }
}
