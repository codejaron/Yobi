import { randomUUID } from "node:crypto";
import {
  type AppConfig,
  type AppStatus,
  type CommandApprovalDecision,
  type ConsoleRunEventV2,
  type MindSnapshot,
  type RelationshipGuide,
  type ScheduledTaskInput,
  type ScheduledTaskToolName,
  type ScheduledTaskRun,
  type UserProfile,
  type HistoryMessage,
  type KernelStateDocument,
} from "@shared/types";
import {
  type RuntimeInboundChannel
} from "@main/storage/runtime-context-store";
import { isConversationAbortError } from "@main/core/conversation-abort";
import { createEmotionTagStripper, extractEmotionTag } from "@main/core/emotion-tags";
import { ExaSearchService } from "@main/services/exa-search";
import { ScheduledTaskService } from "@main/services/scheduled-tasks";
import { ScheduledTaskStore } from "@main/storage/scheduled-task-store";
import { createBuiltinTools } from "@main/tools/builtin";
import { createSkillTools } from "@main/tools/skills";
import { setTokenRecorder } from "@main/services/token/token-usage-reporter";
import {
  ensureKernelBootstrap
} from "@main/kernel/init";
import { WhisperModelManager } from "@main/services/whisper-model-manager";
import { buildRuntimeRegistry, type RuntimeRegistry } from "@main/runtime/runtime-registry";

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
  private readonly pet: RuntimeRegistry["pet"];
  private readonly petService: RuntimeRegistry["petService"];
  private readonly activityCoordinator: RuntimeRegistry["activityCoordinator"];
  private readonly channelCoordinator: RuntimeRegistry["channelCoordinator"];
  private readonly lifecycleCoordinator: RuntimeRegistry["lifecycleCoordinator"];
  private readonly dataCoordinator: RuntimeRegistry["dataCoordinator"];
  private readonly statusCoordinator: RuntimeRegistry["statusCoordinator"];
  private readonly scheduledTaskStore: ScheduledTaskStore;
  private readonly scheduledTaskService: ScheduledTaskService;

  constructor(registry: RuntimeRegistry) {
    this.paths = registry.paths;
    this.logger = registry.logger;
    this.tokenStatsService = registry.tokenStatsService;
    this.configStore = registry.configStore;
    this.runtimeContextStore = registry.runtimeContextStore;
    this.memory = registry.memory;
    this.stateStore = registry.stateStore;
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
    this.pet = registry.pet;
    this.petService = registry.petService;
    this.activityCoordinator = registry.activityCoordinator;
    this.channelCoordinator = registry.channelCoordinator;
    this.lifecycleCoordinator = registry.lifecycleCoordinator;
    this.dataCoordinator = registry.dataCoordinator;
    this.statusCoordinator = registry.statusCoordinator;
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
    this.voiceRouter.syncLocalAsrState(this.paths.whisperModelsDir);
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

    await this.emitStatus();
    this.logger.info("runtime", "start:ready");
  }

  async stop(): Promise<void> {
    setTokenRecorder(null);
    await this.memory.dumpUnprocessedBuffer();

    this.lifecycleCoordinator.stop();
    await this.scheduledTaskService.stop();
    await this.kernel.stop();
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

  getConfig(): AppConfig {
    return this.configStore.getConfig();
  }

  getSpeechRecognitionStatus(): {
    ready: boolean;
    provider: "whisper-local" | "alibaba" | "none";
    message: string;
  } {
    const config = this.getConfig();

    if (config.voice.asrProvider === "whisper-local") {
      const manager = new WhisperModelManager(this.paths.whisperModelsDir);
      if (!manager.isModelDownloaded(config.whisperLocal.modelSize)) {
        return {
          ready: false,
          provider: "whisper-local",
          message: "本地 Whisper 已选中，但模型尚未下载。请先到设置页下载模型。"
        };
      }

      const whisperError = this.voiceRouter.getWhisperFailureReason();
      return {
        ready: this.voiceRouter.isAsrReady(),
        provider: "whisper-local",
        message: this.voiceRouter.isAsrReady()
          ? "本地 Whisper 已就绪。"
          : whisperError
            ? "本地 Whisper 初始化失败：" + whisperError
            : "本地 Whisper 正在加载模型，请稍候再试。"
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
      message: "未启用任何语音识别引擎。请先在设置里开启本地 Whisper 或配置阿里语音。"
    };
  }

  async ensureWhisperModel(input: {
    modelSize?: AppConfig["whisperLocal"]["modelSize"];
    onProgress?: (progress: number) => void;
  }): Promise<{
    ready: boolean;
    path: string;
  }> {
    const manager = new WhisperModelManager(this.paths.whisperModelsDir);
    const modelSize = input.modelSize ?? "base";
    const path = await manager.ensureModel(modelSize, input.onProgress);

    if (this.getConfig().voice.asrProvider === "whisper-local" && this.getConfig().whisperLocal.modelSize === modelSize) {
      this.voiceRouter.syncLocalAsrState(this.paths.whisperModelsDir);
      this.lifecycleCoordinator.applyConfigEffects();
      await this.emitStatus();
    }

    return {
      ready: true,
      path
    };
  }

  getWhisperModelStatus(input?: {
    modelSize?: AppConfig["whisperLocal"]["modelSize"];
  }): {
    enabled: boolean;
    modelSize: AppConfig["whisperLocal"]["modelSize"];
    downloaded: boolean;
    ready: boolean;
  } {
    const config = this.getConfig();
    const modelSize = input?.modelSize ?? config.whisperLocal.modelSize;
    const manager = new WhisperModelManager(this.paths.whisperModelsDir);

    return {
      enabled: config.voice.asrProvider === "whisper-local",
      modelSize,
      downloaded: manager.isModelDownloaded(modelSize),
      ready:
        config.voice.asrProvider === "whisper-local" &&
        config.whisperLocal.modelSize === modelSize &&
        this.voiceRouter.isAsrReady()
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

    this.voiceRouter.syncLocalAsrState(this.paths.whisperModelsDir);
    this.lifecycleCoordinator.applyConfigEffects();

    void this.refreshRuntimeAfterConfigSave(previousConfig, saved);
    return saved;
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

  async startConsoleChat(text: string): Promise<{ requestId: string }> {
    const normalized = text.trim();
    if (!normalized) {
      throw new Error("消息不能为空");
    }

    const requestId = randomUUID();
    this.activeConsoleRequests.set(requestId, {
      abortController: new AbortController(),
      finalized: false,
      finalEventEmitted: false
    });
    queueMicrotask(() => {
      void this.runConsoleChatRequest(requestId, normalized);
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


  async chatFromPet(text: string): Promise<{ replyText: string }> {
    await this.recordUserActivity({
      channel: "console",
      text
    });
    const result = await this.petService.chatFromPet(text);
    if (result.replyText.trim()) {
      await this.kernel.onAssistantMessage();
    }
    return result;
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
    const exaSearchService = new ExaSearchService(() => this.getConfig());

    for (const builtin of createBuiltinTools({
      getConfig: () => this.getConfig(),
      exaSearchService,
      scheduledTaskService: this.scheduledTaskService
    })) {
      this.toolRegistry.register(builtin);
    }

    for (const skillTool of createSkillTools(this.skillManager)) {
      this.toolRegistry.register(skillTool);
    }
  }

  private async runConsoleChatRequest(requestId: string, text: string): Promise<void> {
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
        text
      });

      const reply = await this.withTimeout(
        this.channelRouter.handleConsole({
          text,
          resourceId: PRIMARY_RESOURCE_ID,
          threadId: PRIMARY_THREAD_ID,
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

      latestHandle.finalized = true;
      latestHandle.finishReason = "completed";
      this.emitConsoleFinal(requestId, latestHandle, "completed", visibleReply);
      this.petService.emitPetTalkingReply(visibleReply);
      await this.kernel.onAssistantMessage();
      await this.emitStatus();
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

  private emitConsoleFinal(
    requestId: string,
    handle: ConsoleRequestHandle,
    finishReason: "completed" | "aborted",
    displayText?: string
  ): void {
    if (handle.finalEventEmitted) {
      return;
    }

    handle.finalEventEmitted = true;
    if (finishReason === "aborted") {
      this.consoleChannel.emit({
        requestId,
        type: "final",
        finishReason: "aborted",
        timestamp: new Date().toISOString()
      });
      return;
    }

    const visibleText = displayText?.trim() || "我这次没有生成有效回复，请重试一次。";
    this.consoleChannel.emit({
      requestId,
      type: "final",
      finishReason: "completed",
      rawText: visibleText,
      displayText: visibleText,
      timestamp: new Date().toISOString()
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
    await this.activityCoordinator.recordUserActivity(input);
  }

  private async recordProactiveActivity(): Promise<void> {
    await this.activityCoordinator.recordProactiveActivity();
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

    const config = this.getConfig();
    try {
      const audio = await this.voiceRouter.synthesize({
        text: normalizedMessage,
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
      this.logger.warn("kernel", "proactive:speech-failed", undefined, error);
    }

    this.pet.emitEvent({
      type: "talking",
      value: "talking"
    });
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
