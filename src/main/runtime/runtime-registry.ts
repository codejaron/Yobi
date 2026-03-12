import type { AppConfig } from "@shared/types";
import type { CompanionPaths } from "@main/storage/paths";
import { ConfigStore } from "@main/storage/config";
import {
  RuntimeContextStore,
  type RuntimeInboundChannel
} from "@main/storage/runtime-context-store";
import { ModelFactory } from "@main/core/model-factory";
import { YobiMemory } from "@main/memory/setup";
import { ConversationEngine } from "@main/core/conversation";
import { BilibiliBrowseService } from "@main/services/browse/bilibili-browse-service";
import { BilibiliSyncCoordinator } from "@main/services/browse/bilibili-sync-coordinator";
import { TelegramChannel } from "@main/channels/telegram";
import { ChannelRouter } from "@main/channels/router";
import { ConsoleChannel } from "@main/channels/console";
import { QQChannel } from "@main/channels/qq";
import { FeishuChannel } from "@main/channels/feishu";
import { VoiceService } from "@main/services/voice";
import { VoiceProviderRouter } from "@main/services/voice-router";
import { KeepAwakeService } from "@main/services/keep-awake";
import { McpManager } from "@main/services/mcp-manager";
import { PetWindowController } from "@main/pet/pet-window";
import { RealtimeVoiceService } from "@main/services/realtime-voice";
import { GlobalPetPushToTalkService } from "@main/services/global-ptt";
import { SystemPermissionsService } from "@main/services/system-permissions";
import { PetService } from "@main/services/pet-service";
import { ApprovalGuard } from "@main/tools/guard/approval";
import { DefaultToolRegistry } from "@main/tools/registry";
import { TokenStatsStore } from "@main/services/token/token-stats-store";
import { TokenStatsService } from "@main/services/token/token-stats-service";
import { StateStore } from "@main/kernel/state-store";
import { KernelEngine } from "@main/kernel/engine";
import type { AppLogger } from "@main/services/logger";
import { RuntimeActivityCoordinator } from "@main/runtime/activity-coordinator";
import { ChannelCoordinator } from "@main/runtime/channel-coordinator";
import { LifecycleCoordinator } from "@main/runtime/lifecycle-coordinator";
import { RuntimeDataCoordinator } from "@main/runtime/data-coordinator";
import { RuntimeStatusCoordinator } from "@main/runtime/status-coordinator";
import { BackgroundTaskWorkerService } from "@main/services/background-task-worker";
import { SkillManager } from "@main/skills/manager";
import { appLogger, companionPaths } from "@main/runtime/singletons";
import {
  buildKernelQueueTaskHandlers,
  WorkerProactiveRewriteHandler
} from "@main/kernel/task-handlers";

export interface RuntimeRegistryBuildInput {
  resourceId: string;
  threadId: string;
  chatReplyTimeoutMs: number;
}

export interface RuntimeRegistryCallbacks {
  emitStatus: () => Promise<void>;
  withTimeout: <T>(promise: Promise<T>, timeoutMs: number, label: string) => Promise<T>;
  handleKernelProactive: (message: string) => Promise<void>;
  recordUserActivity: (input: {
    channel: RuntimeInboundChannel;
    chatId?: string;
    text?: string;
  }) => Promise<void>;
  getConfig: () => AppConfig;
}

export interface RuntimeRegistry {
  bootedAt: string;
  paths: CompanionPaths;
  logger: AppLogger;
  tokenStatsStore: TokenStatsStore;
  tokenStatsService: TokenStatsService;
  configStore: ConfigStore;
  runtimeContextStore: RuntimeContextStore;
  memory: YobiMemory;
  modelFactory: ModelFactory;
  stateStore: StateStore;
  approvalGuard: ApprovalGuard;
  toolRegistry: DefaultToolRegistry;
  skillManager: SkillManager;
  mcpManager: McpManager;
  backgroundWorker: BackgroundTaskWorkerService;
  conversation: ConversationEngine;
  bilibiliBrowse: BilibiliBrowseService;
  bilibiliSyncCoordinator: BilibiliSyncCoordinator;
  kernel: KernelEngine;
  channelRouter: ChannelRouter;
  telegram: TelegramChannel;
  feishu: FeishuChannel;
  consoleChannel: ConsoleChannel;
  voiceService: VoiceService;
  voiceRouter: VoiceProviderRouter;
  keepAwake: KeepAwakeService;
  pet: PetWindowController;
  realtimeVoice: RealtimeVoiceService;
  globalPtt: GlobalPetPushToTalkService;
  systemPermissionsService: SystemPermissionsService;
  petService: PetService;
  activityCoordinator: RuntimeActivityCoordinator;
  channelCoordinator: ChannelCoordinator;
  lifecycleCoordinator: LifecycleCoordinator;
  dataCoordinator: RuntimeDataCoordinator;
  statusCoordinator: RuntimeStatusCoordinator;
  bindCallbacks: (callbacks: RuntimeRegistryCallbacks) => void;
}

export function buildRuntimeRegistry(input: RuntimeRegistryBuildInput): RuntimeRegistry {
  const bootedAt = new Date().toISOString();
  const paths = companionPaths;
  const logger = appLogger;
  const tokenStatsStore = new TokenStatsStore(paths);
  const tokenStatsService = new TokenStatsService(tokenStatsStore);
  const configStore = new ConfigStore(paths);
  const runtimeContextStore = new RuntimeContextStore(paths);

  const memory = new YobiMemory(
    paths,
    () => configStore.getConfig()
  );

  const modelFactory = new ModelFactory(() => configStore.getConfig());
  const stateStore = new StateStore(paths);
  const approvalGuard = new ApprovalGuard();
  const toolRegistry = new DefaultToolRegistry(
    () => configStore.getConfig(),
    approvalGuard
  );
  const skillManager = new SkillManager(paths);
  const mcpManager = new McpManager(() => configStore.getConfig());
  const backgroundWorker = new BackgroundTaskWorkerService();

  const callbackBridge: RuntimeRegistryCallbacks = {
    emitStatus: async () => undefined,
    withTimeout: async <T>(promise: Promise<T>) => promise,
    handleKernelProactive: async () => undefined,
    recordUserActivity: async () => undefined,
    getConfig: () => configStore.getConfig()
  };

  const queueHandlers = buildKernelQueueTaskHandlers({
    paths,
    memory,
    getConfig: () => configStore.getConfig(),
    backgroundWorker,
    resourceId: input.resourceId,
    threadId: input.threadId
  });
  const proactiveRewriteHandler = new WorkerProactiveRewriteHandler({
    getConfig: () => configStore.getConfig(),
    backgroundWorker,
    timeoutMs: 10_000
  });

  const kernel = new KernelEngine({
    paths,
    memory,
    stateStore,
    getConfig: () => configStore.getConfig(),
    resourceId: input.resourceId,
    threadId: input.threadId,
    backgroundWorker,
    queueHandlers,
    proactiveRewriteHandler,
    onProactiveMessage: async ({ message }) => {
      await callbackBridge.handleKernelProactive(message);
    }
  });

  const conversation = new ConversationEngine(
    memory,
    modelFactory,
    toolRegistry,
    skillManager,
    stateStore,
    paths,
    () => configStore.getConfig(),
    (signals) => kernel.onRealtimeEmotionalSignals(signals)
  );

  const bilibiliBrowse = new BilibiliBrowseService(
    paths,
    memory,
    () => configStore.getConfig(),
    async (cookie) => {
      const current = configStore.getConfig();
      await configStore.saveConfig({
        ...current,
        browse: {
          ...current.browse,
          bilibiliCookie: cookie
        }
      });
      await callbackBridge.emitStatus();
    }
  );

  const channelRouter = new ChannelRouter(conversation);
  const telegram = new TelegramChannel(() => configStore.getConfig(), {
    onStatusChange: () => {
      void callbackBridge.emitStatus();
    }
  });
  const feishu = new FeishuChannel(() => configStore.getConfig(), {
    onStatusChange: () => {
      void callbackBridge.emitStatus();
    }
  });
  const consoleChannel = new ConsoleChannel();
  const voiceService = new VoiceService();
  const voiceRouter = new VoiceProviderRouter(
    () => configStore.getConfig(),
    voiceService
  );
  const keepAwake = new KeepAwakeService();
  const pet = new PetWindowController();
  const realtimeVoice = new RealtimeVoiceService({
    paths,
    logger,
    getConfig: () => configStore.getConfig(),
    voiceRouter,
    conversation,
    memory,
    defaultTarget: {
      resourceId: input.resourceId,
      threadId: input.threadId
    },
    onRecordUserActivity: (activityInput) => callbackBridge.recordUserActivity(activityInput),
    onAssistantMessage: async () => {
      await kernel.onAssistantMessage();
      await callbackBridge.emitStatus();
    },
    onStatusChange: () => {
      void callbackBridge.emitStatus();
    }
  });
  const globalPtt = new GlobalPetPushToTalkService();
  const systemPermissionsService = new SystemPermissionsService({
    onStatusChange: () => {
      void callbackBridge.emitStatus();
    }
  });
  const petService = new PetService({
    paths,
    getConfig: () => configStore.getConfig(),
    pet,
    stateStore,
    voiceRouter,
    realtimeVoice,
    globalPtt,
    systemPermissionsService,
    channelRouter,
    primaryResourceId: input.resourceId,
    primaryThreadId: input.threadId,
    chatReplyTimeoutMs: input.chatReplyTimeoutMs,
    withTimeout: (promise, timeoutMs, label) => callbackBridge.withTimeout(promise, timeoutMs, label),
    onStatusChange: () => {
      void callbackBridge.emitStatus();
    }
  });

  let channelCoordinatorRef: ChannelCoordinator | null = null;
  const activityCoordinator = new RuntimeActivityCoordinator({
    runtimeContextStore,
    logger,
    getConfig: () => configStore.getConfig(),
    onLastUserLoaded: (value) => kernel.setLastUserMessageAt(value),
    onLastProactiveLoaded: (value) => kernel.setLastProactiveAt(value),
    onUserMessage: (messageInput) => kernel.onUserMessage(messageInput),
    onProactiveMessage: (ts) => kernel.setLastProactiveAt(ts),
    sendTelegram: async (text, chatId) => {
      await telegram.send({ kind: "text", text, chatId });
    },
    sendFeishu: async (text, chatId) => {
      await channelCoordinatorRef?.getFeishuChannel().send({ kind: "text", text, chatId });
    }
  });

  const channelCoordinator = new ChannelCoordinator({
    telegram,
    feishu,
    createQQChannel: (config, callbacks) => new QQChannel(config, callbacks),
    logger,
    pet,
    getQQConfig: () => ({
      enabled: configStore.getConfig().qq.enabled,
      appId: configStore.getConfig().qq.appId.trim(),
      appSecret: configStore.getConfig().qq.appSecret.trim()
    }),
    handleTelegram: (payload) => channelRouter.handleTelegram(payload),
    handleQQ: (payload) => channelRouter.handleQQ(payload),
    handleFeishu: (payload) => channelRouter.handleFeishu(payload),
    onRecordUserActivity: (activityInput) => callbackBridge.recordUserActivity(activityInput),
    onAssistantMessage: () => kernel.onAssistantMessage(),
    emitStatus: () => callbackBridge.emitStatus(),
    withTimeout: (promise, timeoutMs, label) => callbackBridge.withTimeout(promise, timeoutMs, label),
    chatReplyTimeoutMs: input.chatReplyTimeoutMs,
    resourceId: input.resourceId,
    threadId: input.threadId
  });
  channelCoordinatorRef = channelCoordinator;

  const bilibiliSyncCoordinator = new BilibiliSyncCoordinator({
    service: bilibiliBrowse,
    logger,
    getConfig: () => configStore.getConfig(),
    onStatusChange: () => callbackBridge.emitStatus()
  });

  const lifecycleCoordinator = new LifecycleCoordinator({
    keepAwake,
    petService,
    bilibiliSyncCoordinator,
    getConfig: () => configStore.getConfig()
  });

  const dataCoordinator = new RuntimeDataCoordinator({
    paths,
    memory,
    stateStore,
    kernel,
    bilibiliBrowse,
    bilibiliSyncCoordinator,
    systemPermissionsService,
    resourceId: input.resourceId,
    threadId: input.threadId,
    emitStatus: () => callbackBridge.emitStatus()
  });

  const statusCoordinator = new RuntimeStatusCoordinator({
    bootedAt,
    memory,
    kernel,
    bilibiliBrowse,
    tokenStatsService,
    systemPermissionsService,
    activityCoordinator,
    channelCoordinator,
    lifecycleCoordinator,
    resourceId: input.resourceId,
    threadId: input.threadId
  });

  return {
    bootedAt,
    paths,
    logger,
    tokenStatsStore,
    tokenStatsService,
    configStore,
    runtimeContextStore,
    memory,
    modelFactory,
    stateStore,
    approvalGuard,
    toolRegistry,
    skillManager,
    mcpManager,
    backgroundWorker,
    conversation,
    bilibiliBrowse,
    bilibiliSyncCoordinator,
    kernel,
    channelRouter,
    telegram,
    feishu,
    consoleChannel,
    voiceService,
    voiceRouter,
    keepAwake,
    pet,
    realtimeVoice,
    globalPtt,
    systemPermissionsService,
    petService,
    activityCoordinator,
    channelCoordinator,
    lifecycleCoordinator,
    dataCoordinator,
    statusCoordinator,
    bindCallbacks: (callbacks) => {
      callbackBridge.emitStatus = callbacks.emitStatus;
      callbackBridge.withTimeout = callbacks.withTimeout;
      callbackBridge.handleKernelProactive = callbacks.handleKernelProactive;
      callbackBridge.recordUserActivity = callbacks.recordUserActivity;
      callbackBridge.getConfig = callbacks.getConfig;
    }
  };
}
