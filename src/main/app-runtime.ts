import { randomUUID } from "node:crypto";
import {
  type AppConfig,
  type AppStatus,
  type CommandApprovalDecision,
  type ConsoleRunEventV2,
  type MindSnapshot,
  type UserProfile,
  type HistoryMessage,
  type KernelStateDocument,
} from "@shared/types";
import {
  type RuntimeInboundChannel
} from "@main/storage/runtime-context-store";
import { createEmotionTagStripper, extractEmotionTag } from "@main/core/emotion-tags";
import { ExaSearchService } from "@main/services/exa-search";
import { createBuiltinTools } from "@main/tools/builtin";
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

export class CompanionRuntime {
  private static readonly CHAT_REPLY_TIMEOUT_MS = 5 * 60_000;

  private readonly paths: RuntimeRegistry["paths"];
  private readonly logger: RuntimeRegistry["logger"];
  private readonly tokenStatsService: RuntimeRegistry["tokenStatsService"];
  private readonly configStore: RuntimeRegistry["configStore"];
  private readonly reminderStore: RuntimeRegistry["reminderStore"];
  private readonly runtimeContextStore: RuntimeRegistry["runtimeContextStore"];
  private readonly memory: RuntimeRegistry["memory"];
  private readonly stateStore: RuntimeRegistry["stateStore"];
  private readonly toolRegistry: RuntimeRegistry["toolRegistry"];
  private readonly mcpManager: RuntimeRegistry["mcpManager"];
  private readonly conversation: RuntimeRegistry["conversation"];
  private readonly kernel: RuntimeRegistry["kernel"];
  private readonly channelRouter: RuntimeRegistry["channelRouter"];
  private readonly telegram: RuntimeRegistry["telegram"];
  private readonly consoleChannel: RuntimeRegistry["consoleChannel"];
  private readonly voiceRouter: RuntimeRegistry["voiceRouter"];
  private readonly pet: RuntimeRegistry["pet"];
  private readonly petService: RuntimeRegistry["petService"];
  private readonly reminderService: RuntimeRegistry["reminderService"];
  private readonly activityCoordinator: RuntimeRegistry["activityCoordinator"];
  private readonly channelCoordinator: RuntimeRegistry["channelCoordinator"];
  private readonly lifecycleCoordinator: RuntimeRegistry["lifecycleCoordinator"];
  private readonly dataCoordinator: RuntimeRegistry["dataCoordinator"];
  private readonly statusCoordinator: RuntimeRegistry["statusCoordinator"];

  constructor(registry: RuntimeRegistry) {
    this.paths = registry.paths;
    this.logger = registry.logger;
    this.tokenStatsService = registry.tokenStatsService;
    this.configStore = registry.configStore;
    this.reminderStore = registry.reminderStore;
    this.runtimeContextStore = registry.runtimeContextStore;
    this.memory = registry.memory;
    this.stateStore = registry.stateStore;
    this.toolRegistry = registry.toolRegistry;
    this.mcpManager = registry.mcpManager;
    this.conversation = registry.conversation;
    this.kernel = registry.kernel;
    this.channelRouter = registry.channelRouter;
    this.telegram = registry.telegram;
    this.consoleChannel = registry.consoleChannel;
    this.voiceRouter = registry.voiceRouter;
    this.pet = registry.pet;
    this.petService = registry.petService;
    this.reminderService = registry.reminderService;
    this.activityCoordinator = registry.activityCoordinator;
    this.channelCoordinator = registry.channelCoordinator;
    this.lifecycleCoordinator = registry.lifecycleCoordinator;
    this.dataCoordinator = registry.dataCoordinator;
    this.statusCoordinator = registry.statusCoordinator;

    registry.bindCallbacks({
      emitStatus: () => this.emitStatus(),
      withTimeout: (promise, timeoutMs, label) => this.withTimeout(promise, timeoutMs, label),
      handleKernelProactive: (message, topicId) => this.handleKernelProactive(message, topicId),
      recordUserActivity: (input) => this.recordUserActivity(input),
      getConfig: () => this.getConfig()
    });
  }

  private statusListeners = new Set<(status: AppStatus) => void>();

  async init(): Promise<void> {
    this.paths.ensureLayout();
    await this.logger.cleanup(14);
    this.logger.info("runtime", "init:start");
    setTokenRecorder((event) => this.tokenStatsService.record(event));
    await this.configStore.init();
    this.voiceRouter.syncLocalAsrState(this.paths.whisperModelsDir);
    await ensureKernelBootstrap(this.paths);
    await this.reminderStore.init();
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

    await this.emitStatus();
    this.logger.info("runtime", "start:ready");
  }

  async stop(): Promise<void> {
    setTokenRecorder(null);
    await this.memory.dumpUnprocessedBuffer();

    this.lifecycleCoordinator.stop();
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

  async getPersona(): Promise<{ markdown: string; updatedAt: string }> {
    return this.dataCoordinator.getPersona();
  }

  async savePersona(input: { markdown: string }): Promise<{ markdown: string; updatedAt: string }> {
    return this.dataCoordinator.savePersona(input);
  }

  async patchState(input: { patch: Partial<KernelStateDocument> }): Promise<KernelStateDocument> {
    return this.dataCoordinator.patchState(input);
  }

  async patchProfile(input: { patch: Partial<UserProfile> }): Promise<UserProfile> {
    return this.dataCoordinator.patchProfile(input);
  }

  async resetMindSection(input: {
    section: "soul" | "persona" | "state" | "profile" | "facts" | "episodes";
  }): Promise<{ accepted: boolean; message: string }> {
    return this.dataCoordinator.resetMindSection(input);
  }

  async triggerKernelTask(taskType: "tick-now" | "daily-now"): Promise<{ accepted: boolean; message: string }> {
    return this.dataCoordinator.triggerKernelTask(taskType);
  }

  async getStatus(): Promise<AppStatus> {
    return this.statusCoordinator.collectStatus();
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

  async triggerTopicRecall(): Promise<{ accepted: boolean; message: string }> {
    return this.dataCoordinator.triggerTopicRecall();
  }

  async triggerBilibiliSync(): Promise<{ accepted: boolean; message: string }> {
    return this.dataCoordinator.triggerBilibiliSync();
  }

  async openBilibiliAccount(): Promise<{ opened: boolean; message: string }> {
    return this.dataCoordinator.openBilibiliAccount();
  }

  async deleteTopicPoolItem(topicId: string): Promise<{ accepted: boolean; message: string }> {
    return this.dataCoordinator.deleteTopicPoolItem(topicId);
  }

  async clearTopicPool(): Promise<{ accepted: boolean; message: string }> {
    return this.dataCoordinator.clearTopicPool();
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
      reminderService: this.reminderService,
      getConfig: () => this.getConfig(),
      exaSearchService
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
      channel: "console",
      text
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
      await this.kernel.onAssistantMessage();
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

  private async handleKernelProactive(message: string, topicId?: string): Promise<void> {
    const parsedMessage = extractEmotionTag(message);
    const proactiveMessage = parsedMessage.cleanedText.trim() || message.trim();
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
    await this.kernel.onAssistantMessage();
    if (topicId) {
      await this.memory.markUsed(topicId);
    }

    this.consoleChannel.emitExternalAssistantMessage({
      text: proactiveMessage,
      source: "yobi"
    });

    const config = this.getConfig();
    if (config.proactive.pushTargets.telegram || config.proactive.pushTargets.feishu) {
      await this.pushToConfiguredChannels(proactiveMessage, config.proactive.pushTargets);
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
      this.logger.warn("kernel", "proactive:speech-failed", undefined, error);
    }

    this.pet.emitEvent({
      type: "talking",
      value: "talking"
    });
    await this.recordProactiveActivity();
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
