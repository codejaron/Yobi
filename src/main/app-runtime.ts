import { randomUUID } from "node:crypto";
import {
  type AppConfig,
  type AppStatus,
  type ChatAttachment,
  type CommandApprovalDecision,
  type ConsoleChatAttachmentInput,
  type ConsoleRunEventV2,
  type MindSnapshot,
  type RelationshipGuide,
  type ScheduledTaskInput,
  type ScheduledTaskToolName,
  type ScheduledTaskRun,
  type UserProfile,
  type HistoryMessage,
  type KernelStateDocument,
  type VoiceSessionEvent,
  type VoiceSessionState,
  type RealtimeVoiceMode,
  type VoiceInputContext,
  type VoiceSessionTarget,
  type VoiceTranscriptionResult
} from "@shared/types";
import type { ProviderModelListResult } from "@shared/provider-catalog";
import type {
  ActivationLogEntry,
  CognitionConfigPatch,
  CognitionLogScope,
  ColdArchiveStats,
  ConsolidationReport
} from "@shared/cognition";
import {
  type RuntimeInboundChannel
} from "@main/storage/runtime-context-store";
import { isConversationAbortError } from "@main/core/conversation-abort";
import { supportsChatAttachment } from "@main/core/provider-utils";
import { createEmotionTagStripper, extractEmotionTag } from "@main/core/emotion-tags";
import { ChatMediaStore } from "@main/services/chat-media";
import { ExaSearchService } from "@main/services/exa-search";
import { ScheduledTaskService } from "@main/services/scheduled-tasks";
import { ScheduledTaskStore } from "@main/storage/scheduled-task-store";
import { createBuiltinTools } from "@main/tools/builtin";
import { createSkillTools } from "@main/tools/skills";
import { setTokenRecorder } from "@main/services/token/token-usage-reporter";
import {
  ensureKernelBootstrap
} from "@main/kernel/init";
import { SenseVoiceModelManager } from "@main/services/sensevoice-model-manager";
import { CognitionEngine } from "@main/cognition/engine";
import { buildRuntimeRegistry, type RuntimeRegistry } from "@main/runtime/runtime-registry";
import {
  completeConsoleReply,
  emitConsoleFinal as emitConsoleFinalEvent,
  runConsolePostReplyTasks as runConsolePostReplyTasksHelper
} from "@main/runtime/console-chat-lifecycle";

interface HistoryQuery {
  query?: string;
  limit?: number;
  offset?: number;
}

const PRIMARY_RESOURCE_ID = "primary-user";
const PRIMARY_THREAD_ID = "primary-thread";

interface ConsoleRequestHandle {
  abortController: AbortController;
  finalized: boolean;
  finishReason?: "completed" | "aborted" | "error";
  finalEventEmitted: boolean;
  taskMode: boolean;
  voiceContext?: VoiceInputContext;
}

export class CompanionRuntime {
  private static readonly CHAT_REPLY_TIMEOUT_MS = 5 * 60_000;

  private readonly paths: RuntimeRegistry["paths"];
  private readonly logger: RuntimeRegistry["logger"];
  private readonly tokenStatsService: RuntimeRegistry["tokenStatsService"];
  private readonly configStore: RuntimeRegistry["configStore"];
  private readonly runtimeContextStore: RuntimeRegistry["runtimeContextStore"];
  private readonly memory: RuntimeRegistry["memory"];
  private readonly stateStore: RuntimeRegistry["stateStore"];
  private readonly providerModelDiscovery: RuntimeRegistry["providerModelDiscovery"];
  private readonly approvalGuard: RuntimeRegistry["approvalGuard"];
  private readonly toolRegistry: RuntimeRegistry["toolRegistry"];
  private readonly skillManager: RuntimeRegistry["skillManager"];
  private readonly mcpManager: RuntimeRegistry["mcpManager"];
  private readonly conversation: RuntimeRegistry["conversation"];
  private readonly kernel: RuntimeRegistry["kernel"];
  private readonly channelRouter: RuntimeRegistry["channelRouter"];
  private readonly telegram: RuntimeRegistry["telegram"];
  private readonly consoleChannel: RuntimeRegistry["consoleChannel"];
  private readonly voiceRouter: RuntimeRegistry["voiceRouter"];
  private readonly realtimeVoice: RuntimeRegistry["realtimeVoice"];
  private readonly pet: RuntimeRegistry["pet"];
  private readonly petService: RuntimeRegistry["petService"];
  private readonly activityCoordinator: RuntimeRegistry["activityCoordinator"];
  private readonly channelCoordinator: RuntimeRegistry["channelCoordinator"];
  private readonly lifecycleCoordinator: RuntimeRegistry["lifecycleCoordinator"];
  private readonly dataCoordinator: RuntimeRegistry["dataCoordinator"];
  private readonly statusCoordinator: RuntimeRegistry["statusCoordinator"];
  private readonly cognitionEngine: CognitionEngine;
  private readonly scheduledTaskStore: ScheduledTaskStore;
  private readonly scheduledTaskService: ScheduledTaskService;
  private readonly chatMediaStore: ChatMediaStore;
  private chatMediaCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private cognitionTickListeners = new Set<(entry: ActivationLogEntry) => void>();

  constructor(registry: RuntimeRegistry) {
    this.paths = registry.paths;
    this.logger = registry.logger;
    this.tokenStatsService = registry.tokenStatsService;
    this.configStore = registry.configStore;
    this.runtimeContextStore = registry.runtimeContextStore;
    this.memory = registry.memory;
    this.stateStore = registry.stateStore;
    this.providerModelDiscovery = registry.providerModelDiscovery;
    this.approvalGuard = registry.approvalGuard;
    this.toolRegistry = registry.toolRegistry;
    this.skillManager = registry.skillManager;
    this.mcpManager = registry.mcpManager;
    this.conversation = registry.conversation;
    this.kernel = registry.kernel;
    this.channelRouter = registry.channelRouter;
    this.telegram = registry.telegram;
    this.consoleChannel = registry.consoleChannel;
    this.voiceRouter = registry.voiceRouter;
    this.realtimeVoice = registry.realtimeVoice;
    this.pet = registry.pet;
    this.petService = registry.petService;
    this.activityCoordinator = registry.activityCoordinator;
    this.channelCoordinator = registry.channelCoordinator;
    this.lifecycleCoordinator = registry.lifecycleCoordinator;
    this.dataCoordinator = registry.dataCoordinator;
    this.statusCoordinator = registry.statusCoordinator;
    this.cognitionEngine = new CognitionEngine({
      paths: this.paths,
      getConfig: () => this.getConfig(),
      memory: this.memory,
      conversation: this.conversation,
      logger: this.logger,
      getUserOnline: () => this.isCognitionUserOnline(),
      getUserActivityState: () => this.getCognitionUserActivityState(),
      onProactiveMessage: (input) => this.handleCognitionProactive(input),
      onTickCompleted: (entry) => {
        this.emitCognitionTick(entry);
      }
    });
    this.dataCoordinator.setRegenerateCognitionGraphFromSoul(() => this.cognitionEngine.regenerateGraphFromSoul());
    this.conversation.setCognitionMemoryProvider(({ userText }) => this.cognitionEngine.buildReplyMemoryBlock(userText));
    this.channelCoordinator.setPostReplyHook((input) => this.ingestDialogue(input));
    this.realtimeVoice.setAssistantReplyHook((input) => this.ingestDialogue(input));
    this.chatMediaStore = new ChatMediaStore(this.paths);
    this.scheduledTaskStore = new ScheduledTaskStore(this.paths);
    this.scheduledTaskService = new ScheduledTaskService({
      store: this.scheduledTaskStore,
      toolRegistry: this.toolRegistry,
      approvalGuard: this.approvalGuard,
      getConfig: () => this.getConfig(),
      notify: (input) => this.dispatchScheduledNotification(input),
      runAgentTask: (input) => this.runScheduledAgentTask(input)
    });

    registry.bindCallbacks({
      emitStatus: () => this.emitStatus(),
      withTimeout: (promise, timeoutMs, label) => this.withTimeout(promise, timeoutMs, label),
      handleKernelProactive: (message) => this.handleKernelProactive(message),
      recordUserActivity: (input) => this.recordUserActivity(input),
      getConfig: () => this.getConfig()
    });
  }

  private statusListeners = new Set<(status: AppStatus) => void>();
  private activeConsoleRequests = new Map<string, ConsoleRequestHandle>();

  async init(): Promise<void> {
    this.paths.ensureLayout();
    await this.logger.cleanup(14);
    this.logger.info("runtime", "init:start");
    setTokenRecorder((event) => this.tokenStatsService.record(event));
    await this.configStore.init();
    await this.chatMediaStore.cleanupExpired().catch((error) => {
      this.logger.warn("runtime", "chat-media-cleanup-init-failed", undefined, error);
    });
    this.voiceRouter.syncLocalAsrState(this.paths.senseVoiceModelsDir);
    await ensureKernelBootstrap(this.paths);
    await this.skillManager.init();
    await this.scheduledTaskService.init();
    await this.runtimeContextStore.init();
    await this.stateStore.init();
    await this.memory.init();
    await this.kernel.init();

    this.registerBuiltinTools();
    await this.mcpManager.init(this.toolRegistry);

    this.logger.info("runtime", "init:ready");
  }

  async start(): Promise<void> {
    this.loadRuntimeContext();
    await this.lifecycleCoordinator.start();
    await this.startTelegram();
    await this.startFeishu();
    await this.startQQ();
    this.kernel.start();
    await this.scheduledTaskService.start();
    await this.cognitionEngine.start();
    if (!this.chatMediaCleanupTimer) {
      this.chatMediaCleanupTimer = setInterval(() => {
        void this.chatMediaStore.cleanupExpired().catch((error) => {
          this.logger.warn("runtime", "chat-media-cleanup-interval-failed", undefined, error);
        });
      }, 24 * 60 * 60 * 1000);
      this.chatMediaCleanupTimer.unref?.();
    }

    await this.emitStatus();
    this.logger.info("runtime", "start:ready");
  }

  async stop(): Promise<void> {
    setTokenRecorder(null);
    await this.memory.dumpUnprocessedBuffer();

    this.lifecycleCoordinator.stop();
    if (this.chatMediaCleanupTimer) {
      clearInterval(this.chatMediaCleanupTimer);
      this.chatMediaCleanupTimer = null;
    }
    await this.scheduledTaskService.stop();
    await this.kernel.stop();
    await this.cognitionEngine.stop();
    await this.memory.stop();
    await this.mcpManager.dispose();
    await this.toolRegistry.dispose();
    await this.stopFeishu();
    await this.stopQQ();
    await this.telegram.stop();
    this.logger.info("runtime", "stop:complete");
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

  onVoiceSessionEvent(listener: (event: VoiceSessionEvent) => void): () => void {
    return this.realtimeVoice.onEvent(listener);
  }

  getConfig(): AppConfig {
    return this.configStore.getConfig();
  }

  getSpeechRecognitionStatus(): {
    ready: boolean;
    provider: "sensevoice-local" | "alibaba" | "none";
    message: string;
  } {
    const config = this.getConfig();

    if (config.voice.asrProvider === "sensevoice-local") {
      const manager = new SenseVoiceModelManager(this.paths.senseVoiceModelsDir);
      if (!manager.isModelDownloaded(config.senseVoiceLocal.modelName)) {
        return {
          ready: false,
          provider: "sensevoice-local",
          message: "本地 SenseVoice 已选中，但模型尚未下载。请先到设置页下载模型。"
        };
      }

      const senseVoiceError = this.voiceRouter.getSenseVoiceFailureReason();
      return {
        ready: this.voiceRouter.isAsrReady(),
        provider: "sensevoice-local",
        message: this.voiceRouter.isAsrReady()
          ? "本地 SenseVoice 已就绪。"
          : senseVoiceError
            ? "本地 SenseVoice 初始化失败：" + senseVoiceError
            : "本地 SenseVoice 正在加载模型，请稍候再试。"
      };
    }

    if (config.voice.asrProvider === "alibaba") {
      return {
        ready: this.voiceRouter.isAlibabaSttReady(),
        provider: "alibaba",
        message: this.voiceRouter.isAlibabaSttReady()
          ? "阿里语音识别已就绪。"
          : "阿里语音识别未就绪，请先填写 API Key。"
      };
    }

    return {
      ready: false,
      provider: "none",
      message: "未配置语音识别。请先在设置里选择本地 SenseVoice 或阿里语音。"
    };
  }

  async ensureSenseVoiceModel(input: {
    modelName?: AppConfig["senseVoiceLocal"]["modelName"];
    onProgress?: (progress: number) => void;
  }): Promise<{
    ready: boolean;
    path: string;
  }> {
    const manager = new SenseVoiceModelManager(this.paths.senseVoiceModelsDir);
    const modelName = input.modelName ?? "SenseVoiceSmall-int8";
    const path = await manager.ensureModel(modelName, input.onProgress);

    if (
      this.getConfig().voice.asrProvider === "sensevoice-local" &&
      this.getConfig().senseVoiceLocal.modelName === modelName
    ) {
      this.voiceRouter.syncLocalAsrState(this.paths.senseVoiceModelsDir);
      this.lifecycleCoordinator.applyConfigEffects();
      await this.emitStatus();
    }

    return {
      ready: true,
      path
    };
  }

  getSenseVoiceModelStatus(input?: {
    modelName?: AppConfig["senseVoiceLocal"]["modelName"];
  }): {
    enabled: boolean;
    modelName: AppConfig["senseVoiceLocal"]["modelName"];
    downloaded: boolean;
    ready: boolean;
    errorMessage?: string | null;
  } {
    const config = this.getConfig();
    const modelName = input?.modelName ?? config.senseVoiceLocal.modelName;
    const manager = new SenseVoiceModelManager(this.paths.senseVoiceModelsDir);
    const errorMessage =
      config.voice.asrProvider === "sensevoice-local" && config.senseVoiceLocal.modelName === modelName
        ? this.voiceRouter.getSenseVoiceFailureReason()
        : null;

    return {
      enabled: config.voice.asrProvider === "sensevoice-local",
      modelName,
      downloaded: manager.isModelDownloaded(modelName),
      ready:
        config.voice.asrProvider === "sensevoice-local" &&
        config.senseVoiceLocal.modelName === modelName &&
        this.voiceRouter.isAsrReady(),
      errorMessage
    };
  }

  async importPetModelDirectory(sourceDir: string): Promise<{ modelDir: string }> {
    return this.petService.importPetModelDirectory(sourceDir);
  }

  async importSkillDirectory(sourceDir: string) {
    return this.skillManager.importSkillDirectory(sourceDir);
  }

  async listSkills() {
    return this.skillManager.listSkills();
  }

  async rescanSkills() {
    return this.skillManager.rescan();
  }

  async setSkillEnabled(input: { skillId: string; enabled: boolean }) {
    return this.skillManager.setSkillEnabled(input.skillId, input.enabled);
  }

  async deleteSkill(skillId: string) {
    return this.skillManager.deleteSkill(skillId);
  }

  async saveConfig(nextConfig: AppConfig): Promise<AppConfig> {
    const previousConfig = this.configStore.getConfig();
    const saved = await this.configStore.saveConfig(nextConfig);

    this.voiceRouter.syncLocalAsrState(this.paths.senseVoiceModelsDir);
    this.lifecycleCoordinator.applyConfigEffects();

    void this.refreshRuntimeAfterConfigSave(previousConfig, saved);
    return saved;
  }

  async listProviderModels(input: {
    provider: AppConfig["providers"][number];
  }): Promise<ProviderModelListResult> {
    return this.providerModelDiscovery.listModels({
      provider: input.provider
    });
  }

  async getHistory(options: HistoryQuery): Promise<HistoryMessage[]> {
    return this.dataCoordinator.getHistory(options);
  }

  async clearHistory(): Promise<void> {
    await this.dataCoordinator.clearHistory();
  }

  async getMindSnapshot(): Promise<MindSnapshot> {
    return this.dataCoordinator.getMindSnapshot();
  }

  async getSoul(): Promise<{ markdown: string; updatedAt: string }> {
    return this.dataCoordinator.getSoul();
  }

  async saveSoul(input: { markdown: string }): Promise<{ markdown: string; updatedAt: string }> {
    return this.dataCoordinator.saveSoul(input);
  }

  async regenerateCognitionGraphFromSoul(): Promise<{ accepted: boolean; message: string }> {
    return this.dataCoordinator.regenerateCognitionGraphFromSoul();
  }

  async getRelationship(): Promise<{ guide: RelationshipGuide; updatedAt: string }> {
    return this.dataCoordinator.getRelationship();
  }

  async saveRelationship(input: { guide: RelationshipGuide }): Promise<{ guide: RelationshipGuide; updatedAt: string }> {
    return this.dataCoordinator.saveRelationship(input);
  }

  async patchState(input: { patch: Partial<KernelStateDocument> }): Promise<KernelStateDocument> {
    return this.dataCoordinator.patchState(input);
  }

  async patchProfile(input: { patch: Partial<UserProfile> }): Promise<UserProfile> {
    return this.dataCoordinator.patchProfile(input);
  }

  async resetMindSection(input: {
    section: "soul" | "relationship" | "state" | "profile" | "facts" | "episodes";
  }): Promise<{ accepted: boolean; message: string }> {
    return this.dataCoordinator.resetMindSection(input);
  }

  async triggerKernelTask(taskType: "tick-now" | "daily-now"): Promise<{ accepted: boolean; message: string }> {
    return this.dataCoordinator.triggerKernelTask(taskType);
  }

  async getStatus(): Promise<AppStatus> {
    return this.statusCoordinator.collectStatus();
  }

  async getCognitionDebugSnapshot() {
    return this.cognitionEngine.getDebugSnapshot();
  }

  async triggerCognitionManualSpread(input: { text?: string }) {
    return this.cognitionEngine.triggerManualSpread(input.text ?? "");
  }

  async updateCognitionConfig(input: CognitionConfigPatch) {
    return this.cognitionEngine.updateConfig(input);
  }

  async getCognitionHealthMetrics() {
    return this.cognitionEngine.getHealthMetrics();
  }

  async getCognitionBroadcastHistory() {
    return this.cognitionEngine.getBroadcastHistory();
  }

  async clearCognitionLogs(input: { scope: CognitionLogScope }) {
    return this.cognitionEngine.clearLogs(input.scope);
  }

  async triggerCognitionConsolidation(): Promise<ConsolidationReport> {
    return this.cognitionEngine.triggerConsolidation();
  }

  async getCognitionConsolidationReport(): Promise<ConsolidationReport | null> {
    return this.cognitionEngine.getConsolidationReport();
  }

  async getCognitionConsolidationHistory(): Promise<ConsolidationReport[]> {
    return this.cognitionEngine.getConsolidationHistory();
  }

  async getCognitionArchiveStats(): Promise<ColdArchiveStats> {
    return this.cognitionEngine.getArchiveStats();
  }

  async getScheduledTasks(): Promise<{ tasks: ReturnType<ScheduledTaskService["listTasks"]>; runs: ScheduledTaskRun[] }> {
    return this.scheduledTaskService.getSnapshot();
  }

  async saveScheduledTask(
    input: ScheduledTaskInput,
    requestApproval?: (request: Parameters<RuntimeRegistry["approvalGuard"]["ensureApproved"]>[0]) => Promise<CommandApprovalDecision>
  ) {
    return this.scheduledTaskService.saveTask(input, {
      requestApproval: requestApproval as any
    });
  }

  async pauseScheduledTask(taskId: string) {
    return this.scheduledTaskService.pauseTask(taskId);
  }

  async resumeScheduledTask(taskId: string) {
    return this.scheduledTaskService.resumeTask(taskId);
  }

  async deleteScheduledTask(taskId: string) {
    return this.scheduledTaskService.deleteTask(taskId);
  }

  async runScheduledTaskNow(taskId: string) {
    return this.scheduledTaskService.runTaskNow(taskId);
  }

  async startBilibiliQrAuth() {
    return this.dataCoordinator.startBilibiliQrAuth();
  }

  async pollBilibiliQrAuth(input: { qrcodeKey: string }) {
    return this.dataCoordinator.pollBilibiliQrAuth(input);
  }

  async saveBilibiliCookie(input: { cookie: string }) {
    return this.dataCoordinator.saveBilibiliCookie(input);
  }

  async triggerBilibiliSync(): Promise<{ accepted: boolean; message: string }> {
    return this.dataCoordinator.triggerBilibiliSync();
  }

  async openBilibiliAccount(): Promise<{ opened: boolean; message: string }> {
    return this.dataCoordinator.openBilibiliAccount();
  }

  async openSystemPermissionSettings(
    permission: keyof AppStatus["systemPermissions"]
  ): Promise<{ opened: boolean; prompted: boolean }> {
    return this.dataCoordinator.openSystemPermissionSettings(permission);
  }

  async resetSystemPermissions(): Promise<{ reset: boolean; message?: string }> {
    return this.dataCoordinator.resetSystemPermissions();
  }

  async getConsoleChatHistory(input?: {
    cursor?: string;
    limit?: number;
  }): Promise<{
    items: HistoryMessage[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    return this.dataCoordinator.getConsoleChatHistory(input);
  }

  async startConsoleChat(input: string | {
    text?: string;
    voiceContext?: VoiceInputContext;
    attachments?: ConsoleChatAttachmentInput[];
    taskMode?: boolean;
  }): Promise<{ requestId: string }> {
    const text = typeof input === "string" ? input : input?.text ?? "";
    const attachmentInputs = typeof input === "string" ? [] : input?.attachments ?? [];
    const normalized = text.trim();
    const attachments =
      attachmentInputs.length > 0
        ? await this.chatMediaStore.storeConsoleAttachments({
            attachments: attachmentInputs,
            threadId: PRIMARY_THREAD_ID
          })
        : [];

    if (!normalized && attachments.length === 0) {
      throw new Error("消息不能为空");
    }

    const unsupportedAttachment = attachments.find((attachment) => !supportsChatAttachment(this.getConfig(), attachment));
    if (unsupportedAttachment) {
      throw new Error(`当前聊天 provider 不支持附件类型：${unsupportedAttachment.filename} (${unsupportedAttachment.mimeType})`);
    }

    const requestId = randomUUID();
    this.activeConsoleRequests.set(requestId, {
      abortController: new AbortController(),
      finalized: false,
      finalEventEmitted: false,
      taskMode: typeof input === "string" ? false : input?.taskMode === true,
      voiceContext: typeof input === "string" ? undefined : input?.voiceContext
    });
    queueMicrotask(() => {
      void this.runConsoleChatRequest(requestId, normalized, attachments);
    });

    return {
      requestId
    };
  }

  async stopConsoleChat(requestId: string): Promise<{ accepted: boolean }> {
    const handle = this.activeConsoleRequests.get(requestId);
    if (!handle || handle.finalized) {
      return {
        accepted: false
      };
    }

    handle.finalized = true;
    handle.finishReason = "aborted";
    this.consoleChannel.abortPendingApprovalsByRequest(requestId);
    handle.abortController.abort();
    this.emitConsoleFinal(requestId, handle, "aborted");

    return {
      accepted: true
    };
  }

  async resolveConsoleApproval(input: {
    approvalId: string;
    decision: CommandApprovalDecision;
  }): Promise<{ accepted: boolean }> {
    return this.consoleChannel.resolveApproval(input);
  }


  async chatFromPet(text: string, voiceContext?: VoiceInputContext): Promise<{ replyText: string }> {
    await this.recordUserActivity({
      channel: "console",
      text
    });
    const result = await this.petService.chatFromPet(text, voiceContext);
    if (result.replyText.trim()) {
      await this.ingestDialogue({
        channel: "console",
        userText: text,
        assistantText: result.replyText
      });
      await this.kernel.onAssistantMessage();
    }
    return result;
  }

  async transcribeVoiceInput(input: {
    pcm16Base64?: string;
    sampleRate?: number;
  }): Promise<VoiceTranscriptionResult> {
    return this.petService.transcribeVoiceInput(input);
  }

  async transcribeAndSendFromPet(input: {
    pcm16Base64?: string;
    sampleRate?: number;
  }): Promise<{
    sent: boolean;
    text: string;
    metadata?: VoiceTranscriptionResult["metadata"];
    replyText?: string;
    message?: string;
  }> {
    const result = await this.petService.transcribeAndSendFromPet(input);
    if (result.sent && result.text.trim() && result.replyText?.trim()) {
      await this.ingestDialogue({
        channel: "console",
        userText: result.text,
        assistantText: result.replyText
      });
    }
    return result;
  }

  getVoiceSessionState(): VoiceSessionState {
    return this.realtimeVoice.getState();
  }

  async startVoiceSession(input?: {
    mode?: RealtimeVoiceMode;
    target?: Partial<VoiceSessionTarget>;
  }): Promise<VoiceSessionState> {
    return this.realtimeVoice.startSession(input);
  }

  async stopVoiceSession(): Promise<{ accepted: boolean }> {
    return this.realtimeVoice.stopSession();
  }

  async interruptVoiceSession(input?: {
    reason?: "vad" | "manual" | "system";
  }): Promise<{ accepted: boolean }> {
    return this.realtimeVoice.interrupt(input?.reason ?? "manual");
  }

  async setVoiceSessionMode(mode: RealtimeVoiceMode): Promise<VoiceSessionState> {
    return this.realtimeVoice.setMode(mode);
  }

  private registerBuiltinTools(): void {
    const exaSearchService = new ExaSearchService(() => this.getConfig());

    for (const builtin of createBuiltinTools({
      getConfig: () => this.getConfig(),
      exaSearchService,
      scheduledTaskService: this.scheduledTaskService,
      paths: this.paths
    })) {
      this.toolRegistry.register(builtin);
    }

    for (const skillTool of createSkillTools(this.skillManager)) {
      this.toolRegistry.register(skillTool);
    }
  }

  private async runConsoleChatRequest(
    requestId: string,
    text: string,
    attachments: ChatAttachment[]
  ): Promise<void> {
    const deltaStripper = createEmotionTagStripper();
    const handle = this.activeConsoleRequests.get(requestId);

    if (!handle) {
      return;
    }

    try {
      if (!handle.finalized) {
        this.consoleChannel.emit({
          requestId,
          type: "thinking",
          state: "start",
          timestamp: new Date().toISOString()
        });
      }

      await this.recordUserActivity({
        channel: "console",
        text: text || undefined
      });

      const reply = await this.withTimeout(
        this.channelRouter.handleConsole({
          text,
          attachments,
          resourceId: PRIMARY_RESOURCE_ID,
          threadId: PRIMARY_THREAD_ID,
          taskMode: handle.taskMode,
          voiceContext: handle.voiceContext,
          abortSignal: handle.abortController.signal,
          stream: {
            onSkillsCatalog: (payload) => {
              if (this.shouldSuppressConsoleRequestEvent(requestId)) {
                return;
              }
              this.consoleChannel.emit({
                requestId,
                type: "skills-catalog",
                enabledCount: payload.enabledCount,
                truncated: payload.truncated,
                truncatedDescriptions: payload.truncatedDescriptions,
                omittedSkills: payload.omittedSkills,
                timestamp: new Date().toISOString()
              });
            },
            onTextDelta: (delta) => {
              if (this.shouldSuppressConsoleRequestEvent(requestId)) {
                return;
              }
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
              if (this.shouldSuppressConsoleRequestEvent(requestId)) {
                return;
              }
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
              if (this.shouldSuppressConsoleRequestEvent(requestId)) {
                return;
              }
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

              if (
                payload.toolName === "activate_skill" &&
                payload.success &&
                payload.output &&
                typeof payload.output === "object"
              ) {
                const output = payload.output as Record<string, unknown>;
                const skillId = typeof output.skillId === "string" ? output.skillId : "";
                const name = typeof output.name === "string" ? output.name : skillId;
                const compatibility = output.compatibility;
                if (
                  skillId &&
                  compatibility &&
                  typeof compatibility === "object" &&
                  typeof (compatibility as { status?: unknown }).status === "string"
                ) {
                  this.consoleChannel.emit({
                    requestId,
                    type: "skill-activated",
                    skillId,
                    name,
                    compatibility: compatibility as any,
                    timestamp: new Date().toISOString()
                  });
                }
              }
            }
          },
          requestApproval: this.consoleChannel.makeApprovalHandler(requestId)
        }),
        CompanionRuntime.CHAT_REPLY_TIMEOUT_MS,
        "LLM 回复超时"
      );

      const latestHandle = this.activeConsoleRequests.get(requestId);
      if (!latestHandle || latestHandle.finalized) {
        return;
      }

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

      completeConsoleReply({
        requestId,
        handle: latestHandle,
        visibleReply,
        userText: text,
        emitFinal: (finalRequestId, finalHandle, finishReason, displayText) => {
          this.emitConsoleFinal(finalRequestId, finalHandle as ConsoleRequestHandle, finishReason, displayText);
        },
        emitPetTalkingReply: (replyText) => {
          this.petService.emitPetTalkingReply(replyText);
        },
        runPostReplyTasks: (payload) => this.runConsolePostReplyTasks(payload)
      });
    } catch (error) {
      const latestHandle = this.activeConsoleRequests.get(requestId);
      if (latestHandle?.finalized && latestHandle.finishReason === "aborted") {
        return;
      }

      if (isConversationAbortError(error)) {
        if (latestHandle) {
          latestHandle.finalized = true;
          latestHandle.finishReason = "aborted";
          this.emitConsoleFinal(requestId, latestHandle, "aborted");
        }
        return;
      }

      const message = error instanceof Error ? error.message : "处理消息时出现未知错误。";
      if (!latestHandle?.finalized) {
        if (latestHandle) {
          latestHandle.finalized = true;
          latestHandle.finishReason = "error";
        }

        this.consoleChannel.emit({
          requestId,
          type: "error",
          message,
          timestamp: new Date().toISOString()
        });
      }
    } finally {
      const latestHandle = this.activeConsoleRequests.get(requestId);
      this.consoleChannel.abortPendingApprovalsByRequest(requestId);
      if (latestHandle && !latestHandle.finalized) {
        this.consoleChannel.emit({
          requestId,
          type: "thinking",
          state: "stop",
          timestamp: new Date().toISOString()
        });
      }
      this.activeConsoleRequests.delete(requestId);
      await this.emitStatus();
    }
  }

  private shouldSuppressConsoleRequestEvent(requestId: string): boolean {
    const handle = this.activeConsoleRequests.get(requestId);
    return handle?.finalized === true;
  }

  private async runConsolePostReplyTasks(input: {
    channel: "console";
    userText: string;
    assistantText: string;
  }): Promise<void> {
    await runConsolePostReplyTasksHelper({
      ...input,
      ingestDialogue: (payload) => this.ingestDialogue(payload),
      onAssistantMessage: () => this.kernel.onAssistantMessage(),
      emitStatus: () => this.emitStatus(),
      warn: (scope, event, payload, error) => this.logger.warn(scope, event, payload, error)
    });
  }

  private emitConsoleFinal(
    requestId: string,
    handle: ConsoleRequestHandle,
    finishReason: "completed" | "aborted",
    displayText?: string
  ): void {
    emitConsoleFinalEvent({
      requestId,
      handle,
      finishReason,
      displayText,
      emit: (event) => {
        this.consoleChannel.emit({
          ...event,
          timestamp: event.timestamp ?? new Date().toISOString()
        } as ConsoleRunEventV2);
      }
    });
  }

  private async startTelegram(): Promise<void> {
    await this.channelCoordinator.startTelegram();
  }

  private async startQQ(): Promise<void> {
    await this.channelCoordinator.startQQ();
  }

  private async startFeishu(): Promise<void> {
    await this.channelCoordinator.startFeishu();
  }

  private async restartTelegram(): Promise<void> {
    await this.channelCoordinator.restartTelegram();
  }

  private async restartQQ(): Promise<void> {
    await this.channelCoordinator.restartQQ();
  }

  private async restartFeishu(): Promise<void> {
    await this.channelCoordinator.restartFeishu();
  }

  private async stopQQ(): Promise<void> {
    await this.channelCoordinator.stopQQ();
  }

  private async stopFeishu(): Promise<void> {
    await this.channelCoordinator.stopFeishu();
  }

  private loadRuntimeContext(): void {
    this.activityCoordinator.load();
  }

  private async recordUserActivity(input: {
    channel: RuntimeInboundChannel;
    chatId?: string;
    text?: string;
  }): Promise<void> {
    this.cognitionEngine.interruptConsolidation();
    await this.activityCoordinator.recordUserActivity(input);
  }

  private async recordProactiveActivity(): Promise<void> {
    await this.activityCoordinator.recordProactiveActivity();
  }

  onCognitionTick(listener: (entry: ActivationLogEntry) => void): () => void {
    this.cognitionTickListeners.add(listener);

    return () => {
      this.cognitionTickListeners.delete(listener);
    };
  }

  private emitCognitionTick(entry: ActivationLogEntry): void {
    for (const listener of this.cognitionTickListeners) {
      listener(entry);
    }
  }

  private async ingestDialogue(input: {
    channel: RuntimeInboundChannel;
    assistantText: string;
    userText?: string;
    chatId?: string;
  }): Promise<void> {
    try {
      await this.cognitionEngine.ingestDialogue(input);
    } catch (error) {
      this.logger.warn("cognition", "ingest-dialogue-failed", undefined, error);
    }
  }

  private async handleCognitionProactive(input: {
    message: string;
    metadata?: {
      proactive?: boolean;
      source?: string;
    };
    pushTargets?: {
      telegram: boolean;
      feishu: boolean;
    };
    recordProactive?: boolean;
  }): Promise<void> {
    const normalized = input.message?.trim();
    if (!normalized) {
      return;
    }
    await this.dispatchAssistantAutomationMessage({
      message: normalized,
      metadata: {
        proactive: input.metadata?.proactive ?? true,
        source: "yobi"
      },
      pushTargets: input.pushTargets ?? this.getConfig().proactive.pushTargets,
      recordProactive: input.recordProactive ?? true
    });
  }

  private async handleKernelProactive(message: string): Promise<void> {
    await this.dispatchAssistantAutomationMessage({
      message,
      metadata: {
        proactive: true,
        source: "yobi"
      },
      pushTargets: this.getConfig().proactive.pushTargets,
      recordProactive: true
    });
  }

  private async dispatchScheduledNotification(input: {
    text: string;
    pushTargets?: {
      telegram: boolean;
      feishu: boolean;
    };
  }): Promise<void> {
    await this.dispatchAssistantAutomationMessage({
      message: input.text,
      metadata: {
        source: "yobi"
      },
      pushTargets: input.pushTargets ?? this.getConfig().proactive.pushTargets,
      recordProactive: false
    });
  }

  private async runScheduledAgentTask(input: {
    taskId: string;
    taskName: string;
    prompt: string;
    allowedToolNames: ScheduledTaskToolName[];
    pushTargets?: {
      telegram: boolean;
      feishu: boolean;
    };
  }): Promise<{ replyText: string }> {
    const replyText = await this.conversation.reply({
      text: input.prompt,
      channel: "console",
      resourceId: PRIMARY_RESOURCE_ID,
      threadId: PRIMARY_THREAD_ID,
      persistUserMessage: false,
      allowedToolNames: input.allowedToolNames,
      preapprovedToolNames: input.allowedToolNames
    });

    await this.broadcastScheduledAgentReply({
      text: replyText,
      pushTargets: input.pushTargets ?? this.getConfig().proactive.pushTargets
    });

    return {
      replyText
    };
  }

  private async broadcastScheduledAgentReply(input: {
    text: string;
    pushTargets: {
      telegram: boolean;
      feishu: boolean;
    };
  }): Promise<void> {
    const normalizedMessage = input.text.trim();
    if (!normalizedMessage) {
      return;
    }

    this.consoleChannel.emitExternalAssistantMessage({
      text: normalizedMessage,
      source: "yobi"
    });

    if (input.pushTargets.telegram || input.pushTargets.feishu) {
      await this.pushToConfiguredChannels(normalizedMessage, input.pushTargets);
    }

    await this.emitStatus();
  }

  private async dispatchAssistantAutomationMessage(input: {
    message: string;
    metadata: {
      proactive?: boolean;
      source: "yobi";
    };
    pushTargets: {
      telegram: boolean;
      feishu: boolean;
    };
    recordProactive: boolean;
  }): Promise<void> {
    const parsedMessage = extractEmotionTag(input.message);
    const normalizedMessage = parsedMessage.cleanedText.trim() || input.message.trim();
    if (!normalizedMessage) {
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
      text: normalizedMessage,
      metadata: input.metadata
    });
    await this.kernel.onAssistantMessage();

    this.consoleChannel.emitExternalAssistantMessage({
      text: normalizedMessage,
      source: "yobi"
    });

    if (input.pushTargets.telegram || input.pushTargets.feishu) {
      await this.pushToConfiguredChannels(normalizedMessage, input.pushTargets);
    }

    if (input.metadata.proactive === true || input.recordProactive) {
      await this.pushToLastQQChat(normalizedMessage);
    }

    this.petService.emitPetTalkingReply(normalizedMessage);
    if (input.recordProactive) {
      await this.recordProactiveActivity();
    }
    await this.emitStatus();
  }

  private async pushToConfiguredChannels(
    text: string,
    targets: {
      telegram: boolean;
      feishu: boolean;
    }
  ): Promise<void> {
    await this.activityCoordinator.pushToConfiguredChannels(text, targets);
  }

  private async pushToLastQQChat(text: string): Promise<void> {
    const qqChannel = this.channelCoordinator.getQQChannel();
    const targetChatId = this.activityCoordinator.getSnapshot().lastQQChatId;
    if (!qqChannel || !qqChannel.isConnected() || !targetChatId?.trim()) {
      return;
    }

    try {
      await qqChannel.send({
        kind: "text",
        text,
        chatId: targetChatId
      });
    } catch (error) {
      this.logger.warn("cognition", "proactive:qq-push-failed", undefined, error);
    }
  }

  private isCognitionUserOnline(): boolean {
    if (this.consoleChannel.hasListeners()) {
      return true;
    }

    const activity = this.activityCoordinator.getSnapshot();
    const config = this.getConfig();
    const telegramReachable =
      config.proactive.pushTargets.telegram &&
      Boolean((activity.lastTelegramChatId ?? config.telegram.chatId).trim());
    const feishuReachable =
      config.proactive.pushTargets.feishu &&
      Boolean(activity.lastFeishuChatId?.trim());
    const qqReachable =
      this.channelCoordinator.isQQConnected() &&
      Boolean(activity.lastQQChatId?.trim());

    return telegramReachable || feishuReachable || qqReachable;
  }

  private getCognitionUserActivityState(): { online: boolean; last_active: number | null } {
    const activity = this.activityCoordinator.getSnapshot();
    const lastActive = activity.lastUserAt ? Date.parse(activity.lastUserAt) : Number.NaN;
    return {
      online: this.isCognitionUserOnline(),
      last_active: Number.isFinite(lastActive) ? lastActive : null
    };
  }


  private async emitStatus(): Promise<void> {
    if (this.statusListeners.size === 0) {
      return;
    }

    const status = await this.statusCoordinator.collectStatus();
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

  private async refreshRuntimeAfterConfigSave(
    previousConfig: AppConfig,
    nextConfig: AppConfig
  ): Promise<void> {
    if (JSON.stringify(previousConfig.kernel.personality) !== JSON.stringify(nextConfig.kernel.personality)) {
      this.kernel.syncPersonalityFromConfig();
    }

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

    if (this.shouldRestartFeishu(previousConfig, nextConfig)) {
      await this.runConfigSideEffect("重启飞书通道", 8_000, async () => {
        await this.restartFeishu();
      });
    }

    if (JSON.stringify(previousConfig.tools.mcp) !== JSON.stringify(nextConfig.tools.mcp)) {
      await this.runConfigSideEffect("重连 MCP 工具", 20_000, async () => {
        await this.toolRegistry.unregisterBySource("mcp");
        await this.mcpManager.dispose();
        await this.mcpManager.init(this.toolRegistry);
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

  private shouldRestartFeishu(previousConfig: AppConfig, nextConfig: AppConfig): boolean {
    return (
      previousConfig.feishu.enabled !== nextConfig.feishu.enabled ||
      previousConfig.feishu.appId !== nextConfig.feishu.appId ||
      previousConfig.feishu.appSecret !== nextConfig.feishu.appSecret
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
      this.logger.warn("runtime", "config-side-effect-failed", { label }, error);
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

export function createRuntime(): CompanionRuntime {
  const registry = buildRuntimeRegistry({
    resourceId: PRIMARY_RESOURCE_ID,
    threadId: PRIMARY_THREAD_ID,
    chatReplyTimeoutMs: 5 * 60_000
  });
  return new CompanionRuntime(registry);
}
