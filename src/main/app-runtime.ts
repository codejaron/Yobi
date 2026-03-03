import { randomUUID } from "node:crypto";
import type {
  AppConfig,
  AppStatus,
  CharacterProfile,
  ClawEvent,
  ClawHistoryItem,
  CommandApprovalDecision,
  ConsoleRunEventV2,
  HistoryMessage,
  WorkingMemoryDocument
} from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import { ConfigStore } from "@main/storage/config";
import { ReminderStore } from "@main/storage/reminder-store";
import {
  RuntimeContextStore,
  type RuntimeInboundChannel
} from "@main/storage/runtime-context-store";
import { CharacterStore } from "@main/core/character";
import { createEmotionTagStripper, extractEmotionTag } from "@main/core/emotion-tags";
import { ModelFactory } from "@main/core/model-factory";
import { YobiMemory } from "@main/memory/setup";
import { ConversationEngine } from "@main/core/conversation";
import { ProactiveService } from "@main/services/proactive";
import { BackgroundTaskService } from "@main/services/background-tasks";
import { TelegramChannel } from "@main/channels/telegram";
import type { InboundMessage } from "@main/channels/types";
import { ChannelRouter } from "@main/channels/router";
import { ConsoleChannel } from "@main/channels/console";
import { QQChannel } from "@main/channels/qq";
import type { QQChannelConfig } from "@main/channels/qq-types";
import { VoiceService } from "@main/services/voice";
import { VoiceProviderRouter } from "@main/services/voice-router";
import { KeepAwakeService } from "@main/services/keep-awake";
import { ReminderService } from "@main/services/reminders";
import { McpManager } from "@main/services/mcp-manager";
import { PetWindowController } from "@main/pet/pet-window";
import { RealtimeVoiceService } from "@main/services/realtime-voice";
import { GlobalPetPushToTalkService } from "@main/services/global-ptt";
import { SystemPermissionsService } from "@main/services/system-permissions";
import { PetService } from "@main/services/pet-service";
import { OpenClawRuntime } from "@main/openclaw/runtime";
import { ClawClient } from "@main/claw/claw-client";
import { ClawChannel } from "@main/claw/claw-channel";
import { createClawToolDefinition } from "@main/claw/tool";
import { createBuiltinTools } from "@main/tools/builtin";
import { ApprovalGuard } from "@main/tools/guard/approval";
import { DefaultToolRegistry } from "@main/tools/registry";

interface HistoryQuery {
  query?: string;
  limit?: number;
  offset?: number;
}

const PRIMARY_RESOURCE_ID = "primary-user";
const PRIMARY_THREAD_ID = "primary-thread";

export class CompanionRuntime {
  private static readonly CHAT_REPLY_TIMEOUT_MS = 5 * 60_000;
  private static readonly PROACTIVE_DECISION_TIMEOUT_MS = 45_000;

  private readonly bootedAt = new Date().toISOString();
  private readonly paths = new CompanionPaths();
  private readonly configStore = new ConfigStore(this.paths);
  private readonly reminderStore = new ReminderStore(this.paths);
  private readonly runtimeContextStore = new RuntimeContextStore(this.paths);
  private readonly characterStore = new CharacterStore(this.paths);

  private readonly memory = new YobiMemory(
    this.paths,
    () => this.configStore.getConfig(),
    () => this.characterStore.getCharacter(this.configStore.getConfig().characterId)
  );

  private readonly modelFactory = new ModelFactory(() => this.configStore.getConfig());
  private readonly approvalGuard = new ApprovalGuard();
  private readonly toolRegistry = new DefaultToolRegistry(
    () => this.configStore.getConfig(),
    this.approvalGuard
  );
  private readonly mcpManager = new McpManager(() => this.configStore.getConfig());

  private readonly conversation = new ConversationEngine(
    this.memory,
    this.modelFactory,
    this.toolRegistry,
    this.characterStore,
    () => this.configStore.getConfig()
  );

  private readonly proactive = new ProactiveService(
    this.modelFactory,
    this.memory,
    this.characterStore,
    () => this.configStore.getConfig()
  );
  private readonly backgroundTasks = new BackgroundTaskService(
    this.modelFactory,
    this.memory,
    this.mcpManager,
    () => this.configStore.getConfig(),
    {
      resourceId: PRIMARY_RESOURCE_ID,
      threadId: PRIMARY_THREAD_ID,
      statePath: this.paths.backgroundTaskStatePath,
      onTopicPoolUpdated: () => this.emitStatus()
    }
  );

  private readonly channelRouter = new ChannelRouter(this.conversation);
  private readonly telegram = new TelegramChannel(() => this.configStore.getConfig());
  private qqChannel: QQChannel | null = null;
  private readonly consoleChannel = new ConsoleChannel();
  private readonly voiceService = new VoiceService();
  private readonly voiceRouter = new VoiceProviderRouter(
    () => this.configStore.getConfig(),
    this.voiceService
  );
  private readonly keepAwake = new KeepAwakeService();
  private readonly pet = new PetWindowController();
  private readonly realtimeVoice = new RealtimeVoiceService();
  private readonly globalPtt = new GlobalPetPushToTalkService();
  private readonly systemPermissionsService = new SystemPermissionsService({
    onStatusChange: () => this.emitStatus()
  });
  private readonly petService = new PetService({
    paths: this.paths,
    getConfig: () => this.configStore.getConfig(),
    pet: this.pet,
    voiceRouter: this.voiceRouter,
    realtimeVoice: this.realtimeVoice,
    globalPtt: this.globalPtt,
    systemPermissionsService: this.systemPermissionsService,
    channelRouter: this.channelRouter,
    primaryResourceId: PRIMARY_RESOURCE_ID,
    primaryThreadId: PRIMARY_THREAD_ID,
    chatReplyTimeoutMs: CompanionRuntime.CHAT_REPLY_TIMEOUT_MS,
    withTimeout: (promise, timeoutMs, label) => this.withTimeout(promise, timeoutMs, label),
    onStatusChange: () => this.emitStatus()
  });
  private readonly openclawRuntime = new OpenClawRuntime(this.paths, () => {
    void this.emitStatus();
  });
  private readonly clawClient = new ClawClient(
    () => this.configStore.getConfig(),
    () => this.openclawRuntime.getGatewayAuthToken()
  );
  private readonly clawChannel = new ClawChannel(this.clawClient, {
    defaultSessionKey: "main",
    onYobiFinal: async ({ text }) => {
      await this.memory.rememberMessage({
        threadId: PRIMARY_THREAD_ID,
        resourceId: PRIMARY_RESOURCE_ID,
        role: "assistant",
        text,
        metadata: {
          channel: "console",
          source: "claw"
        }
      });

      this.consoleChannel.emitExternalAssistantMessage({
        text,
        source: "claw"
      });
      await this.emitStatus();
    }
  });

  private readonly reminderService = new ReminderService(this.reminderStore, {
    sendReminder: async (item) => {
      await this.telegram.send({
        kind: "text",
        text: `⏰ 提醒：${item.text}`
      });
    }
  });

  private statusListeners = new Set<(status: AppStatus) => void>();
  private clawEventListeners = new Set<(event: ClawEvent) => void>();
  private lastUserAt: string | null = null;
  private lastProactiveAt: string | null = null;
  private lastInboundChannel: RuntimeInboundChannel | null = null;
  private lastInboundChatId: string | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;
  private lastSilenceEvaluatedAt: string | null = null;

  async init(): Promise<void> {
    this.paths.ensureLayout();
    await this.configStore.init();
    await this.reminderStore.init();
    await this.runtimeContextStore.init();
    await this.characterStore.init();

    this.registerBuiltinTools();
    await this.mcpManager.init(this.toolRegistry);

    this.clawChannel.onEvent((event) => {
      for (const listener of this.clawEventListeners) {
        listener(event);
      }
    });
  }

  async start(): Promise<void> {
    this.loadRuntimeContext();
    await this.reminderService.init();
    await this.startTelegram();
    await this.startQQ();
    this.backgroundTasks.start();

    this.keepAwake.apply(this.getConfig().background.keepAwake);
    this.petService.syncPetWindow();
    await this.petService.syncGlobalPetPushToTalk();
    this.petService.syncRealtimeVoice();
    this.startSilenceLoop();

    await this.openclawRuntime.start(this.getConfig());
    const openclawStatus = this.openclawRuntime.getStatus();

    if (this.getConfig().openclaw.enabled && openclawStatus.online) {
      void this.clawChannel.connect().catch(() => {
        // 连接失败时由 ClawClient 重连策略继续处理
      });
    } else {
      await this.clawChannel.disconnect();
    }
    await this.emitStatus();
  }

  async stop(): Promise<void> {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }

    this.keepAwake.stop();
    this.petService.stop();
    this.backgroundTasks.stop();
    await this.clawChannel.disconnect();
    await this.openclawRuntime.stop();
    this.clawChannel.dispose();
    await this.mcpManager.dispose();
    await this.toolRegistry.dispose();
    await this.stopQQ();
    await this.telegram.stop();
  }

  onStatus(listener: (status: AppStatus) => void): () => void {
    this.statusListeners.add(listener);
    void this.emitStatus();

    return () => {
      this.statusListeners.delete(listener);
    };
  }

  onConsoleRunEvent(listener: (event: ConsoleRunEventV2) => void): () => void {
    return this.consoleChannel.onEvent(listener);
  }

  onClawEvent(listener: (event: ClawEvent) => void): () => void {
    this.clawEventListeners.add(listener);
    return () => {
      this.clawEventListeners.delete(listener);
    };
  }

  getClawConnectionEvent(): ClawEvent {
    const status = this.clawClient.getConnectionStatus();
    return {
      type: "connection",
      state: status.state,
      message: status.message,
      timestamp: new Date().toISOString()
    };
  }

  getClawTaskMonitorEvent(): ClawEvent {
    return this.clawChannel.getTaskMonitorEvent();
  }

  getConfig(): AppConfig {
    return this.configStore.getConfig();
  }

  async importPetModelDirectory(sourceDir: string): Promise<{ modelDir: string }> {
    return this.petService.importPetModelDirectory(sourceDir);
  }

  async saveConfig(nextConfig: AppConfig): Promise<AppConfig> {
    const previousConfig = this.configStore.getConfig();
    const saved = await this.configStore.saveConfig(nextConfig);

    this.keepAwake.apply(saved.background.keepAwake);
    this.petService.syncPetWindow();
    await this.petService.syncGlobalPetPushToTalk();
    this.petService.syncRealtimeVoice();
    this.startSilenceLoop();

    void this.refreshRuntimeAfterConfigSave(previousConfig, saved);
    return saved;
  }

  async getCharacter(characterId: string): Promise<CharacterProfile> {
    return this.characterStore.getCharacter(characterId);
  }

  async saveCharacter(profile: CharacterProfile): Promise<void> {
    await this.characterStore.saveCharacter(profile);
  }

  async getHistory(options: HistoryQuery): Promise<HistoryMessage[]> {
    return this.memory.listHistory({
      resourceId: PRIMARY_RESOURCE_ID,
      threadId: PRIMARY_THREAD_ID,
      query: options.query,
      limit: options.limit,
      offset: options.offset
    });
  }

  async clearHistory(): Promise<void> {
    await this.memory.clearThread({
      resourceId: PRIMARY_RESOURCE_ID,
      threadId: PRIMARY_THREAD_ID
    });
    await this.emitStatus();
  }

  async getWorkingMemory(): Promise<WorkingMemoryDocument> {
    return this.memory.getWorkingMemory({
      resourceId: PRIMARY_RESOURCE_ID,
      threadId: PRIMARY_THREAD_ID
    });
  }

  async saveWorkingMemory(input: { markdown: string }): Promise<WorkingMemoryDocument> {
    return this.memory.saveWorkingMemory({
      resourceId: PRIMARY_RESOURCE_ID,
      threadId: PRIMARY_THREAD_ID,
      markdown: input.markdown
    });
  }

  async getStatus(): Promise<AppStatus> {
    return this.collectStatus();
  }

  async triggerRecallTask(): Promise<{ accepted: boolean; message: string }> {
    const result = await this.backgroundTasks.triggerRecallNow();
    await this.emitStatus();
    return result;
  }

  async triggerWanderTask(): Promise<{ accepted: boolean; message: string }> {
    const result = await this.backgroundTasks.triggerWanderNow();
    await this.emitStatus();
    return result;
  }

  async deleteTopicPoolItem(topicId: string): Promise<{ accepted: boolean; message: string }> {
    const removed = await this.memory.deleteTopic(topicId);
    await this.emitStatus();
    return {
      accepted: removed,
      message: removed ? "话题已删除。" : "未找到该话题，可能已被清理。"
    };
  }

  async clearTopicPool(): Promise<{ accepted: boolean; message: string }> {
    const removedCount = await this.memory.clearTopicPool();
    await this.emitStatus();
    return {
      accepted: true,
      message: removedCount > 0 ? `已清空话题池，共删除 ${removedCount} 条。` : "话题池已经是空的。"
    };
  }

  async openSystemPermissionSettings(
    permission: keyof AppStatus["systemPermissions"]
  ): Promise<{ opened: boolean; prompted: boolean }> {
    return this.systemPermissionsService.openSystemPermissionSettings(permission);
  }

  async resetSystemPermissions(): Promise<{ reset: boolean; message?: string }> {
    return this.systemPermissionsService.resetSystemPermissions();
  }

  async getConsoleChatHistory(input?: {
    cursor?: string;
    limit?: number;
  }): Promise<{
    items: HistoryMessage[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    return this.memory.listHistoryByCursor({
      resourceId: PRIMARY_RESOURCE_ID,
      threadId: PRIMARY_THREAD_ID,
      beforeId: input?.cursor,
      limit: input?.limit ?? 20
    });
  }

  async startConsoleChat(text: string): Promise<{ requestId: string }> {
    const normalized = text.trim();
    if (!normalized) {
      throw new Error("消息不能为空");
    }

    const requestId = randomUUID();
    queueMicrotask(() => {
      void this.runConsoleChatRequest(requestId, normalized);
    });

    return {
      requestId
    };
  }

  async resolveConsoleApproval(input: {
    approvalId: string;
    decision: CommandApprovalDecision;
  }): Promise<{ accepted: boolean }> {
    return this.consoleChannel.resolveApproval(input);
  }

  async clawConnect(): Promise<{ connected: boolean; message: string }> {
    const gatewayReadyReason = this.getClawGatewayReadyError();
    if (gatewayReadyReason) {
      return {
        connected: false,
        message: gatewayReadyReason
      };
    }

    try {
      await this.clawChannel.connect();
      return {
        connected: true,
        message: "Claw 已连接"
      };
    } catch (error) {
      return {
        connected: false,
        message: error instanceof Error ? error.message : "Claw 连接失败"
      };
    }
  }

  async clawDisconnect(): Promise<{ connected: boolean; message: string }> {
    await this.clawChannel.disconnect();
    return {
      connected: false,
      message: "Claw 已断开"
    };
  }

  async clawSend(message: string): Promise<{ accepted: boolean; message: string }> {
    const normalized = message.trim();
    if (!normalized) {
      throw new Error("消息不能为空");
    }

    const gatewayReadyReason = this.getClawGatewayReadyError();
    if (gatewayReadyReason) {
      return {
        accepted: false,
        message: gatewayReadyReason
      };
    }

    try {
      await this.clawChannel.sendFromClaw("main", normalized);
      return {
        accepted: true,
        message: "消息已发送到 Claw"
      };
    } catch (error) {
      return {
        accepted: false,
        message: error instanceof Error ? error.message : "发送失败"
      };
    }
  }

  async clawHistory(limit = 50): Promise<{ items: ClawHistoryItem[] }> {
    const gatewayReadyReason = this.getClawGatewayReadyError();
    if (gatewayReadyReason) {
      return {
        items: []
      };
    }

    const items = await this.clawChannel.getHistory("main", limit);
    return {
      items
    };
  }

  async clawAbort(): Promise<{ accepted: boolean; message: string }> {
    const gatewayReadyReason = this.getClawGatewayReadyError();
    if (gatewayReadyReason) {
      return {
        accepted: false,
        message: gatewayReadyReason
      };
    }

    try {
      await this.clawChannel.abort("main");
      return {
        accepted: true,
        message: "已发送中止请求"
      };
    } catch (error) {
      return {
        accepted: false,
        message: error instanceof Error ? error.message : "中止失败"
      };
    }
  }

  private getClawGatewayReadyError(): string | null {
    const config = this.getConfig();
    if (!config.openclaw.enabled) {
      return "OpenClaw 未启用";
    }

    const status = this.openclawRuntime.getStatus();
    if (!status.online) {
      return "OpenClaw Gateway 尚未就绪，请稍后再试。";
    }

    return null;
  }

  async chatFromPet(text: string): Promise<{ replyText: string }> {
    return this.petService.chatFromPet(text);
  }

  async transcribeVoiceInput(input: {
    pcm16Base64?: string;
    sampleRate?: number;
  }): Promise<{
    text: string;
  }> {
    return this.petService.transcribeVoiceInput(input);
  }

  async transcribeAndSendFromPet(input: {
    pcm16Base64?: string;
    sampleRate?: number;
  }): Promise<{
    sent: boolean;
    text: string;
    replyText?: string;
    message?: string;
  }> {
    return this.petService.transcribeAndSendFromPet(input);
  }

  private registerBuiltinTools(): void {
    this.toolRegistry.register(createClawToolDefinition(this.clawChannel));

    for (const builtin of createBuiltinTools({
      reminderService: this.reminderService
    })) {
      this.toolRegistry.register(builtin);
    }
  }

  private async runConsoleChatRequest(requestId: string, text: string): Promise<void> {
    const deltaStripper = createEmotionTagStripper();

    this.consoleChannel.emit({
      requestId,
      type: "thinking",
      state: "start",
      timestamp: new Date().toISOString()
    });

    await this.recordUserActivity({
      channel: "console"
    });

    try {
      const reply = await this.withTimeout(
        this.channelRouter.handleConsole({
          text,
          resourceId: PRIMARY_RESOURCE_ID,
          threadId: PRIMARY_THREAD_ID,
          stream: {
            onTextDelta: (delta) => {
              const visibleDelta = deltaStripper.push(delta);
              if (!visibleDelta) {
                return;
              }

              this.consoleChannel.emit({
                requestId,
                type: "text-delta",
                delta: visibleDelta,
                timestamp: new Date().toISOString()
              });
            },
            onToolCall: (payload) => {
              this.consoleChannel.emit({
                requestId,
                type: "tool-call",
                toolCallId: payload.toolCallId,
                toolName: payload.toolName,
                input: payload.input,
                timestamp: new Date().toISOString()
              });
            },
            onToolResult: (payload) => {
              this.consoleChannel.emit({
                requestId,
                type: "tool-result",
                toolCallId: payload.toolCallId,
                toolName: payload.toolName,
                input: payload.input,
                output: payload.output,
                error: payload.error,
                success: payload.success,
                timestamp: new Date().toISOString()
              });
            }
          },
          requestApproval: this.consoleChannel.makeApprovalHandler(requestId)
        }),
        CompanionRuntime.CHAT_REPLY_TIMEOUT_MS,
        "LLM 回复超时"
      );

      const trailingDelta = deltaStripper.flush();
      if (trailingDelta) {
        this.consoleChannel.emit({
          requestId,
          type: "text-delta",
          delta: trailingDelta,
          timestamp: new Date().toISOString()
        });
      }

      const parsedReply = extractEmotionTag(reply);
      const visibleReply = parsedReply.cleanedText.trim() || "我这次没有生成有效回复，请重试一次。";
      if (parsedReply.emotion) {
        this.pet.emitEvent({
          type: "emotion",
          value: parsedReply.emotion
        });
      }

      this.consoleChannel.emit({
        requestId,
        type: "final",
        rawText: visibleReply,
        displayText: visibleReply,
        timestamp: new Date().toISOString()
      });
      this.petService.emitPetTalkingReply(visibleReply);
      await this.emitStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : "处理消息时出现未知错误。";
      this.consoleChannel.emit({
        requestId,
        type: "error",
        message,
        timestamp: new Date().toISOString()
      });
    } finally {
      this.consoleChannel.flushByRequest(requestId);
      this.consoleChannel.emit({
        requestId,
        type: "thinking",
        state: "stop",
        timestamp: new Date().toISOString()
      });
      await this.emitStatus();
    }
  }

  private async startTelegram(): Promise<void> {
    await this.telegram.start(async (inbound) => {
      try {
        await this.handleTelegramInbound(inbound);
      } catch (error) {
        console.error("[runtime] telegram inbound failed:", error);
        const message =
          error instanceof Error ? `处理消息时出错：${error.message}` : "处理消息时出现未知错误。";
        await this.telegram.send({
          kind: "text",
          text: message,
          chatId: inbound.chatId
        });
      }
      await this.emitStatus();
    });
  }

  private async startQQ(): Promise<void> {
    const config = this.getConfig().qq;
    if (!config.enabled || !config.appId.trim() || !config.appSecret.trim()) {
      await this.stopQQ();
      return;
    }

    await this.stopQQ();

    this.qqChannel = new QQChannel({
      enabled: config.enabled,
      appId: config.appId.trim(),
      appSecret: config.appSecret.trim()
    } satisfies QQChannelConfig);

    await this.qqChannel.start(async (inbound) => {
      try {
        await this.handleQQInbound(inbound);
      } catch (error) {
        console.error("[runtime] qq inbound failed:", error);
        const message =
          error instanceof Error ? `处理消息时出错：${error.message}` : "处理消息时出现未知错误。";
        await this.qqChannel?.send({
          kind: "text",
          text: message,
          chatId: inbound.chatId
        });
      }
      await this.emitStatus();
    });
  }

  private async restartTelegram(): Promise<void> {
    await this.telegram.stop();
    await this.startTelegram();
  }

  private async restartQQ(): Promise<void> {
    await this.stopQQ();
    await this.startQQ();
  }

  private async stopQQ(): Promise<void> {
    if (!this.qqChannel) {
      return;
    }

    await this.qqChannel.stop();
    this.qqChannel = null;
  }

  private async handleTelegramInbound(inbound: InboundMessage): Promise<void> {
    this.pet.emitEvent({
      type: "thinking",
      value: "start"
    });
    await this.recordUserActivity({
      channel: "telegram",
      chatId: inbound.chatId
    });

    try {
      const reply = await this.withTimeout(
        this.channelRouter.handleTelegram({
          text: inbound.text,
          photoUrl: inbound.photoUrl,
          resourceId: PRIMARY_RESOURCE_ID,
          threadId: PRIMARY_THREAD_ID
        }),
        CompanionRuntime.CHAT_REPLY_TIMEOUT_MS,
        "LLM 回复超时"
      );
      const parsedReply = extractEmotionTag(reply);
      const visibleReply = parsedReply.cleanedText.trim();

      if (parsedReply.emotion) {
        this.pet.emitEvent({
          type: "emotion",
          value: parsedReply.emotion
        });
      }

      if (visibleReply) {
        await this.telegram.send({
          kind: "text",
          text: visibleReply,
          chatId: inbound.chatId
        });
      }
    } finally {
      this.pet.emitEvent({
        type: "thinking",
        value: "stop"
      });
    }
  }

  private async handleQQInbound(inbound: InboundMessage): Promise<void> {
    this.pet.emitEvent({
      type: "thinking",
      value: "start"
    });
    await this.recordUserActivity({
      channel: "qq",
      chatId: inbound.chatId
    });

    try {
      const reply = await this.withTimeout(
        this.channelRouter.handleQQ({
          text: inbound.text,
          photoUrl: inbound.photoUrl,
          resourceId: PRIMARY_RESOURCE_ID,
          threadId: PRIMARY_THREAD_ID
        }),
        CompanionRuntime.CHAT_REPLY_TIMEOUT_MS,
        "LLM 回复超时"
      );
      const parsedReply = extractEmotionTag(reply);
      const visibleReply = parsedReply.cleanedText.trim();

      if (parsedReply.emotion) {
        this.pet.emitEvent({
          type: "emotion",
          value: parsedReply.emotion
        });
      }

      if (visibleReply) {
        await this.qqChannel?.send({
          kind: "text",
          text: visibleReply,
          chatId: inbound.chatId
        });
      }
    } finally {
      this.pet.emitEvent({
        type: "thinking",
        value: "stop"
      });
    }
  }

  private startSilenceLoop(): void {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
    }

    this.silenceTimer = setInterval(() => {
      void this.checkSilence();
    }, 60_000);
  }

  private async checkSilence(): Promise<void> {
    const proactiveConfig = this.getConfig().proactive;
    if (!proactiveConfig.enabled) {
      this.lastSilenceEvaluatedAt = null;
      return;
    }

    if (!this.lastUserAt) {
      this.lastSilenceEvaluatedAt = null;
      return;
    }

    const now = Date.now();
    const lastUserTime = new Date(this.lastUserAt).getTime();
    if (!Number.isFinite(lastUserTime)) {
      this.lastSilenceEvaluatedAt = null;
      return;
    }

    const silenceMs = now - lastUserTime;

    if (silenceMs < proactiveConfig.silenceThresholdMs) {
      this.lastSilenceEvaluatedAt = null;
      return;
    }

    if (this.lastProactiveAt) {
      const lastProactiveTime = new Date(this.lastProactiveAt).getTime();
      if (Number.isFinite(lastProactiveTime) && lastProactiveTime > lastUserTime) {
        return;
      }
    }

    if (this.lastSilenceEvaluatedAt) {
      const lastEvaluatedTime = new Date(this.lastSilenceEvaluatedAt).getTime();
      if (
        Number.isFinite(lastEvaluatedTime) &&
        now - lastEvaluatedTime < proactiveConfig.cooldownMs
      ) {
        return;
      }
    }

    this.lastSilenceEvaluatedAt = new Date(now).toISOString();
    try {
      await this.handleProactive({
        trigger: {
          type: "silence",
          detail: `用户已沉默 ${Math.floor(silenceMs / 60000)} 分钟`
        }
      });
    } catch (error) {
      console.warn("[proactive] silence check failed:", error);
      return;
    }
    await this.emitStatus();
  }

  private async handleProactive(input: {
    trigger: { type: "silence"; detail: string };
  }): Promise<void> {
    if (!this.getConfig().proactive.enabled) {
      return;
    }

    const decision = await this.withTimeout(
      this.proactive.evaluate({
        trigger: input.trigger,
        resourceId: PRIMARY_RESOURCE_ID,
        threadId: PRIMARY_THREAD_ID,
        lastProactiveAt: this.lastProactiveAt
      }),
      CompanionRuntime.PROACTIVE_DECISION_TIMEOUT_MS,
      "主动消息决策超时"
    );

    if (!decision.speak || !decision.message) {
      return;
    }

    const parsedMessage = extractEmotionTag(decision.message);
    const proactiveMessage = parsedMessage.cleanedText.trim() || decision.message.trim();
    if (!proactiveMessage) {
      return;
    }

    if (parsedMessage.emotion) {
      this.pet.emitEvent({
        type: "emotion",
        value: parsedMessage.emotion
      });
    }

    await this.conversation.rememberAssistantMessage({
      threadId: PRIMARY_THREAD_ID,
      resourceId: PRIMARY_RESOURCE_ID,
      channel: "console",
      text: proactiveMessage,
      metadata: {
        proactive: true,
        source: "yobi"
      }
    });

    this.consoleChannel.emitExternalAssistantMessage({
      text: proactiveMessage,
      source: "yobi"
    });

    const config = this.getConfig();
    if (!config.proactive.localOnly) {
      await this.pushProactiveToExternalChannel(proactiveMessage);
    }

    try {
      const audio = await this.voiceRouter.synthesize({
        text: proactiveMessage,
        edgeConfig: {
          voice: config.voice.ttsVoice,
          rate: config.voice.ttsRate,
          pitch: config.voice.ttsPitch,
          requestTimeoutMs: config.voice.requestTimeoutMs,
          retryCount: config.voice.retryCount
        }
      });

      this.pet.emitEvent({
        type: "speech",
        audioBase64: audio.toString("base64"),
        mimeType: "audio/mpeg"
      });
    } catch (error) {
      console.warn("[proactive] local speech failed:", error);
    }

    this.pet.emitEvent({
      type: "talking",
      value: "talking"
    });
    await this.recordProactiveActivity();
  }

  private loadRuntimeContext(): void {
    const context = this.runtimeContextStore.getContext();
    this.lastUserAt = context.lastUserAt;
    this.lastProactiveAt = context.lastProactiveAt;
    this.lastInboundChannel = context.lastInboundChannel;
    this.lastInboundChatId = context.lastInboundChatId;
    this.lastSilenceEvaluatedAt = null;
  }

  private async recordUserActivity(input: {
    channel: RuntimeInboundChannel;
    chatId?: string;
  }): Promise<void> {
    this.lastUserAt = new Date().toISOString();
    this.lastInboundChannel = input.channel;
    this.lastInboundChatId = input.chatId?.trim() ? input.chatId.trim() : null;
    this.lastSilenceEvaluatedAt = null;
    await this.persistRuntimeContext();
  }

  private async recordProactiveActivity(): Promise<void> {
    this.lastProactiveAt = new Date().toISOString();
    await this.persistRuntimeContext();
  }

  private async persistRuntimeContext(): Promise<void> {
    try {
      await this.runtimeContextStore.saveContext({
        lastProactiveAt: this.lastProactiveAt,
        lastUserAt: this.lastUserAt,
        lastInboundChannel: this.lastInboundChannel,
        lastInboundChatId: this.lastInboundChatId
      });
    } catch (error) {
      console.warn("[runtime] runtime context save failed:", error);
    }
  }

  private async pushProactiveToExternalChannel(text: string): Promise<void> {
    if (this.lastInboundChannel === "telegram") {
      const configuredChatId = this.getConfig().telegram.chatId.trim();
      const targetChatId = this.lastInboundChatId ?? configuredChatId;
      if (!targetChatId) {
        return;
      }

      try {
        await this.telegram.send({
          kind: "text",
          text,
          chatId: targetChatId
        });
      } catch (error) {
        console.warn("[proactive] telegram push failed:", error);
      }
      return;
    }

    if (this.lastInboundChannel !== "qq") {
      return;
    }

    const targetChatId = this.lastInboundChatId?.trim();
    if (!targetChatId) {
      return;
    }

    try {
      await this.qqChannel?.send({
        kind: "text",
        text,
        chatId: targetChatId
      });
    } catch (error) {
      console.warn("[proactive] qq push failed:", error);
    }
  }

  private async collectStatus(): Promise<AppStatus> {
    this.systemPermissionsService.refreshSystemPermissions();
    const openclawStatus = this.openclawRuntime.getStatus();
    return {
      bootedAt: this.bootedAt,
      telegramConnected: this.telegram.isConnected(),
      qqConnected: this.qqChannel?.isConnected() ?? false,
      lastUserAt: this.lastUserAt,
      lastProactiveAt: this.lastProactiveAt,
      historyCount: await this.memory.countHistory({
        resourceId: PRIMARY_RESOURCE_ID,
        threadId: PRIMARY_THREAD_ID
      }),
      keepAwakeActive: this.keepAwake.isActive(),
      topicPool: await this.memory.listTopicPool(50),
      petOnline: this.petService.isPetOnline(),
      openclawOnline: openclawStatus.online,
      openclawStatus: openclawStatus.message,
      systemPermissions: this.systemPermissionsService.getSnapshot()
    };
  }

  private async emitStatus(): Promise<void> {
    if (this.statusListeners.size === 0) {
      return;
    }

    const status = await this.collectStatus();
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

  private async refreshRuntimeAfterConfigSave(
    previousConfig: AppConfig,
    nextConfig: AppConfig
  ): Promise<void> {
    if (this.shouldRestartTelegram(previousConfig, nextConfig)) {
      await this.runConfigSideEffect("重启 Telegram", 8_000, async () => {
        await this.restartTelegram();
      });
    }

    if (this.shouldRestartQQ(previousConfig, nextConfig)) {
      await this.runConfigSideEffect("重启 QQ 通道", 8_000, async () => {
        await this.restartQQ();
      });
    }

    if (JSON.stringify(previousConfig.tools.mcp) !== JSON.stringify(nextConfig.tools.mcp)) {
      await this.runConfigSideEffect("重连 MCP 工具", 20_000, async () => {
        await this.toolRegistry.unregisterBySource("mcp");
        await this.mcpManager.dispose();
        await this.mcpManager.init(this.toolRegistry);
      });
    }

    const openclawChanged =
      JSON.stringify(previousConfig.openclaw) !== JSON.stringify(nextConfig.openclaw) ||
      JSON.stringify(previousConfig.providers) !== JSON.stringify(nextConfig.providers) ||
      JSON.stringify(previousConfig.modelRouting) !== JSON.stringify(nextConfig.modelRouting);

    if (openclawChanged) {
      await this.runConfigSideEffect("重启 OpenClaw", 20_000, async () => {
        await this.clawChannel.disconnect();
        await this.openclawRuntime.start(nextConfig);
        if (nextConfig.openclaw.enabled && this.openclawRuntime.getStatus().online) {
          await this.clawChannel.connect();
        }
      });
    }

    if (JSON.stringify(previousConfig.proactive) !== JSON.stringify(nextConfig.proactive)) {
      await this.runConfigSideEffect("重置后台话题任务", 4_000, async () => {
        this.backgroundTasks.start();
      });
    }

    await this.runConfigSideEffect("刷新运行状态", 4_000, async () => {
      await this.emitStatus();
    });
  }

  private shouldRestartTelegram(previousConfig: AppConfig, nextConfig: AppConfig): boolean {
    return (
      previousConfig.telegram.enabled !== nextConfig.telegram.enabled ||
      previousConfig.telegram.botToken !== nextConfig.telegram.botToken ||
      previousConfig.telegram.chatId !== nextConfig.telegram.chatId
    );
  }

  private shouldRestartQQ(previousConfig: AppConfig, nextConfig: AppConfig): boolean {
    return (
      previousConfig.qq.enabled !== nextConfig.qq.enabled ||
      previousConfig.qq.appId !== nextConfig.qq.appId ||
      previousConfig.qq.appSecret !== nextConfig.qq.appSecret
    );
  }

  private async runConfigSideEffect(
    label: string,
    timeoutMs: number,
    task: () => void | Promise<void>
  ): Promise<void> {
    try {
      await this.withTimeout(Promise.resolve().then(task), timeoutMs, label);
    } catch (error) {
      console.warn(`[runtime] ${label} 失败:`, error);
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label}（${Math.floor(timeoutMs / 1000)} 秒）`));
      }, timeoutMs);

      promise
        .then((value) => resolve(value))
        .catch((error) => reject(error))
        .finally(() => clearTimeout(timer));
    });
  }
}

export const runtime = new CompanionRuntime();
