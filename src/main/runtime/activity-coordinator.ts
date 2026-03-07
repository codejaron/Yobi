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
}

interface ActivityCoordinatorInput {
  runtimeContextStore: RuntimeContextStore;
  logger: AppLogger;
  getConfig: () => AppConfig;
  onLastUserLoaded: (value: string | null) => void;
  onLastProactiveLoaded: (value: string | null) => void;
  onUserMessage: (input: { ts: string; text?: string }) => Promise<void>;
  onProactiveMessage: (ts: string) => void;
  sendTelegram: (text: string, chatId: string) => Promise<void>;
  sendQQ: (text: string, chatId: string) => Promise<void>;
}

export class RuntimeActivityCoordinator {
  private state: ActivityCoordinatorState = {
    lastUserAt: null,
    lastProactiveAt: null,
    lastInboundChannel: null,
    lastInboundChatId: null
  };

  constructor(private readonly input: ActivityCoordinatorInput) {}

  load(): void {
    const context = this.input.runtimeContextStore.getContext();
    this.state = {
      lastUserAt: context.lastUserAt,
      lastProactiveAt: context.lastProactiveAt,
      lastInboundChannel: context.lastInboundChannel,
      lastInboundChatId: context.lastInboundChatId
    };
    this.input.onLastUserLoaded(this.state.lastUserAt);
    this.input.onLastProactiveLoaded(this.state.lastProactiveAt);
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
    await this.persist();
    await this.input.onUserMessage({
      ts: this.state.lastUserAt,
      text: input.text
    });
  }

  async recordProactiveActivity(): Promise<void> {
    this.state.lastProactiveAt = new Date().toISOString();
    await this.persist();
    this.input.onProactiveMessage(this.state.lastProactiveAt);
  }

  async pushToRecentInboundChannel(text: string): Promise<void> {
    if (this.state.lastInboundChannel === "telegram") {
      const configuredChatId = this.input.getConfig().telegram.chatId.trim();
      const targetChatId = this.state.lastInboundChatId ?? configuredChatId;
      if (!targetChatId) {
        return;
      }

      try {
        await this.input.sendTelegram(text, targetChatId);
      } catch (error) {
        this.input.logger.warn("kernel", "proactive:telegram-push-failed", undefined, error);
      }
      return;
    }

    if (this.state.lastInboundChannel !== "qq") {
      return;
    }

    const targetChatId = this.state.lastInboundChatId?.trim();
    if (!targetChatId) {
      return;
    }

    try {
      await this.input.sendQQ(text, targetChatId);
    } catch (error) {
      this.input.logger.warn("kernel", "proactive:qq-push-failed", undefined, error);
    }
  }

  private async persist(): Promise<RuntimeContextStoreDocument | null> {
    try {
      return await this.input.runtimeContextStore.saveContext({
        lastProactiveAt: this.state.lastProactiveAt,
        lastUserAt: this.state.lastUserAt,
        lastInboundChannel: this.state.lastInboundChannel,
        lastInboundChatId: this.state.lastInboundChatId
      });
    } catch (error) {
      this.input.logger.warn("runtime", "persist-runtime-context-failed", undefined, error);
      return null;
    }
  }
}
