import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { app, desktopCapturer, shell, systemPreferences } from "electron";
import type {
  AppConfig,
  AppStatus,
  CharacterProfile,
  CommandApprovalDecision,
  ConsoleRunEventV2,
  HistoryMessage,
  PermissionState,
  SystemPermissionStatus,
  WorkingMemoryDocument
} from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import { ConfigStore } from "@main/storage/config";
import { ReminderStore } from "@main/storage/reminder-store";
import { CharacterStore } from "@main/core/character";
import { ModelFactory } from "@main/core/model-factory";
import { YobiMemory } from "@main/memory/setup";
import { ConversationEngine } from "@main/core/conversation";
import { ProactiveService } from "@main/services/proactive";
import { BackgroundTaskService } from "@main/services/background-tasks";
import { TelegramChannel } from "@main/channels/telegram";
import type { InboundMessage } from "@main/channels/types";
import { ChannelRouter } from "@main/channels/router";
import { ConsoleChannel } from "@main/channels/console";
import { VoiceService } from "@main/services/voice";
import { VoiceProviderRouter } from "@main/services/voice-router";
import { KeepAwakeService } from "@main/services/keep-awake";
import { ReminderService } from "@main/services/reminders";
import { McpManager } from "@main/services/mcp-manager";
import { PetWindowController } from "@main/pet/pet-window";
import { RealtimeVoiceService } from "@main/services/realtime-voice";
import { GlobalPetPushToTalkService, type GlobalPttPhase } from "@main/services/global-ptt";
import { OpenClawRuntime } from "@main/openclaw/runtime";
import { OpenClawClient } from "@main/openclaw/client";
import { createOpenClawToolDefinition } from "@main/openclaw/tool";
import { createBuiltinTools } from "@main/tools/builtin";
import { ApprovalGuard } from "@main/tools/guard/approval";
import { DefaultToolRegistry } from "@main/tools/registry";

interface HistoryQuery {
  query?: string;
  limit?: number;
  offset?: number;
}

type SystemPermissionKey = keyof SystemPermissionStatus;
type MediaPermissionKey = "microphone" | "screen";
const execFileAsync = promisify(execFile);

const PRIMARY_RESOURCE_ID = "primary-user";
const PRIMARY_THREAD_ID = "primary-thread";

export class CompanionRuntime {
  private static readonly CHAT_REPLY_TIMEOUT_MS = 5 * 60_000;
  private static readonly PROACTIVE_DECISION_TIMEOUT_MS = 45_000;

  private readonly bootedAt = new Date().toISOString();
  private readonly paths = new CompanionPaths();
  private readonly configStore = new ConfigStore(this.paths);
  private readonly reminderStore = new ReminderStore(this.paths);
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
      threadId: PRIMARY_THREAD_ID
    }
  );

  private readonly channelRouter = new ChannelRouter(this.conversation);
  private readonly telegram = new TelegramChannel(() => this.configStore.getConfig());
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
  private readonly openclawClient = new OpenClawClient(() => this.configStore.getConfig());
  private readonly openclawRuntime = new OpenClawRuntime(this.paths, () => {
    void this.emitStatus();
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
  private lastUserAt: string | null = null;
  private lastProactiveAt: string | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;
  private lastSilenceHandledAt: string | null = null;
  private petPttRecording = false;
  private systemPermissions: SystemPermissionStatus = {
    accessibility: "unknown",
    microphone: "unknown",
    screenCapture: "unknown"
  };

  async init(): Promise<void> {
    this.paths.ensureLayout();
    await this.configStore.init();
    await this.reminderStore.init();
    await this.characterStore.init();

    this.registerBuiltinTools();
    await this.mcpManager.init(this.toolRegistry);
  }

  async start(): Promise<void> {
    await this.reminderService.init();
    await this.startTelegram();
    this.backgroundTasks.start();

    this.keepAwake.apply(this.getConfig().background.keepAwake);
    this.syncPetWindow();
    await this.syncGlobalPetPushToTalk();
    this.syncRealtimeVoice();
    this.startSilenceLoop();

    void this.openclawRuntime.start(this.getConfig());
    await this.emitStatus();
  }

  async stop(): Promise<void> {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }

    this.keepAwake.stop();
    this.pet.close();
    this.globalPtt.stop();
    this.petPttRecording = false;
    this.realtimeVoice.stop();
    this.backgroundTasks.stop();
    await this.openclawRuntime.stop();
    await this.mcpManager.dispose();
    await this.toolRegistry.dispose();
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

  getConfig(): AppConfig {
    return this.configStore.getConfig();
  }

  async importPetModelDirectory(sourceDir: string): Promise<{ modelDir: string }> {
    const resolvedSourceDir = path.resolve(sourceDir);

    let sourceStat;
    try {
      sourceStat = await stat(resolvedSourceDir);
    } catch {
      throw new Error("选择的模型目录不存在。");
    }

    if (!sourceStat.isDirectory()) {
      throw new Error("请选择模型文件夹，而不是文件。");
    }

    const containsModelFile = await this.containsModel3JsonFile(resolvedSourceDir);
    if (!containsModelFile) {
      throw new Error("所选目录内未找到 .model3.json 文件。");
    }

    await mkdir(this.paths.modelsDir, {
      recursive: true
    });

    const managedModelsDir = path.resolve(this.paths.modelsDir);
    if (resolvedSourceDir === managedModelsDir) {
      throw new Error("请选择具体模型文件夹，不要选择 models 根目录。");
    }

    const baseName = this.normalizeModelDirectoryName(path.basename(resolvedSourceDir));
    let targetDir = path.join(this.paths.modelsDir, baseName);
    if (existsSync(targetDir)) {
      targetDir = path.join(this.paths.modelsDir, `${baseName}-${Date.now()}`);
    }

    await cp(resolvedSourceDir, targetDir, {
      recursive: true,
      force: true
    });

    const copiedContainsModelFile = await this.containsModel3JsonFile(targetDir);
    if (!copiedContainsModelFile) {
      throw new Error("模型导入失败：复制后未找到 .model3.json 文件。");
    }

    return {
      modelDir: targetDir
    };
  }

  async saveConfig(nextConfig: AppConfig): Promise<AppConfig> {
    const previousConfig = this.configStore.getConfig();
    const saved = await this.configStore.saveConfig(nextConfig);

    this.keepAwake.apply(saved.background.keepAwake);
    this.syncPetWindow();
    await this.syncGlobalPetPushToTalk();
    this.syncRealtimeVoice();
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

  async openSystemPermissionSettings(
    permission: SystemPermissionKey
  ): Promise<{ opened: boolean; prompted: boolean }> {
    const initialState = this.getSystemPermissionState(permission);
    this.systemPermissions[permission] = initialState;
    if (initialState === "granted") {
      await this.emitStatus();
      return {
        opened: false,
        prompted: false
      };
    }

    let prompted = false;

    if (process.platform === "darwin") {
      if (permission === "accessibility") {
        try {
          prompted = true;
          systemPreferences.isTrustedAccessibilityClient(true);
        } catch (error) {
          console.warn("[runtime] request accessibility permission failed:", error);
        }
        this.systemPermissions.accessibility = this.getAccessibilityPermissionState();
      }

      if (permission === "microphone") {
        try {
          const rawStatus = this.getMediaAccessRawStatus("microphone");
          if (rawStatus === "not-determined") {
            prompted = true;
            const granted = await systemPreferences.askForMediaAccess("microphone");
            this.systemPermissions.microphone = granted ? "granted" : "denied";
          }
        } catch (error) {
          console.warn("[runtime] request microphone permission failed:", error);
        }
      }

      if (permission === "screenCapture") {
        const rawStatus = this.getMediaAccessRawStatus("screen");
        if (rawStatus === "not-determined") {
          prompted = true;
          await this.tryRequestScreenCapturePermissionOnMac();
        }
        this.systemPermissions.screenCapture = this.getMediaPermissionState("screen");
      }

      const latestState = this.getSystemPermissionState(permission);
      this.systemPermissions[permission] = latestState;
      await this.emitStatus();
      if (latestState === "granted") {
        return {
          opened: false,
          prompted
        };
      }

      if (prompted) {
        return {
          opened: false,
          prompted: true
        };
      }
    }

    const target = this.resolveSystemPermissionSettingsTarget(permission);
    if (!target) {
      return {
        opened: false,
        prompted: false
      };
    }

    try {
      await shell.openExternal(target);
      return {
        opened: true,
        prompted: false
      };
    } catch (error) {
      console.warn("[runtime] open system permission settings failed:", error);
      return {
        opened: false,
        prompted: false
      };
    }
  }

  async resetSystemPermissions(): Promise<{ reset: boolean; message?: string }> {
    if (process.platform !== "darwin") {
      return {
        reset: false,
        message: "当前平台不支持重置系统权限。"
      };
    }

    try {
      const bundleId = await this.resolveCurrentBundleId();
      if (!bundleId) {
        return {
          reset: false,
          message: "无法识别当前应用标识，重置权限失败。"
        };
      }
      await execFileAsync("tccutil", ["reset", "All", bundleId]);
      await this.emitStatus();
      return {
        reset: true,
        message: `已重置 ${bundleId} 的系统权限。`
      };
    } catch (error) {
      console.warn("[runtime] reset system permissions failed:", error);
      return {
        reset: false,
        message: "重置权限失败，请稍后重试。"
      };
    }
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

  async chatFromPet(text: string): Promise<{ replyText: string }> {
    const normalized = text.trim();
    if (!normalized) {
      return { replyText: "" };
    }

    this.pet.emitEvent({
      type: "thinking",
      value: "start"
    });

    try {
      const reply = await this.withTimeout(
        this.channelRouter.handleConsole({
          text: normalized,
          resourceId: PRIMARY_RESOURCE_ID,
          threadId: PRIMARY_THREAD_ID
        }),
        CompanionRuntime.CHAT_REPLY_TIMEOUT_MS,
        "LLM 回复超时"
      );

      this.emitPetTalkingReply(reply);

      return {
        replyText: reply
      };
    } finally {
      this.pet.emitEvent({
        type: "thinking",
        value: "stop"
      });
    }
  }

  async transcribeVoiceInput(input: {
    pcm16Base64?: string;
    sampleRate?: number;
  }): Promise<{
    text: string;
  }> {
    const pcm16Base64 = typeof input.pcm16Base64 === "string" ? input.pcm16Base64.trim() : "";
    if (!pcm16Base64) {
      throw new Error("录音数据为空。");
    }

    if (!this.voiceRouter.isAlibabaSttReady()) {
      throw new Error("阿里语音识别未启用，请在设置里先打开开关并填写 API Key。");
    }

    let pcm: Buffer;
    try {
      pcm = Buffer.from(pcm16Base64, "base64");
    } catch {
      throw new Error("录音数据格式不合法。");
    }

    if (pcm.length === 0) {
      throw new Error("录音数据为空。");
    }

    const sampleRate = Number.isFinite(input.sampleRate) ? Number(input.sampleRate) : 16_000;
    const text = await this.voiceRouter.transcribePcm16({
      pcm,
      sampleRate
    });

    return {
      text
    };
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
    if (!this.voiceRouter.isAlibabaSttReady()) {
      return {
        sent: false,
        text: "",
        message: "阿里语音识别未启用"
      };
    }

    const transcribed = await this.transcribeVoiceInput(input);
    const text = transcribed.text.trim();
    if (!text) {
      return {
        sent: false,
        text: "",
        message: "未识别到有效语音"
      };
    }

    const replied = await this.chatFromPet(text);
    return {
      sent: true,
      text,
      replyText: replied.replyText
    };
  }

  private registerBuiltinTools(): void {
    this.toolRegistry.register(createOpenClawToolDefinition(this.openclawClient));

    for (const builtin of createBuiltinTools({
      reminderService: this.reminderService,
      voiceRouter: this.voiceRouter,
      petBridge: this.pet
    })) {
      this.toolRegistry.register(builtin);
    }
  }

  private async runConsoleChatRequest(requestId: string, text: string): Promise<void> {
    this.consoleChannel.emit({
      requestId,
      type: "thinking",
      state: "start",
      timestamp: new Date().toISOString()
    });

    try {
      const reply = await this.withTimeout(
        this.channelRouter.handleConsole({
          text,
          resourceId: PRIMARY_RESOURCE_ID,
          threadId: PRIMARY_THREAD_ID,
          stream: {
            onTextDelta: (delta) => {
              this.consoleChannel.emit({
                requestId,
                type: "text-delta",
                delta,
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

      this.consoleChannel.emit({
        requestId,
        type: "final",
        rawText: reply,
        displayText: reply,
        timestamp: new Date().toISOString()
      });
      this.emitPetTalkingReply(reply);

      this.lastUserAt = new Date().toISOString();
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
        await this.handleInbound(inbound);
      } catch (error) {
        console.error("[runtime] handleInbound failed:", error);
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

  private async restartTelegram(): Promise<void> {
    await this.telegram.stop();
    await this.startTelegram();
  }

  private async handleInbound(inbound: InboundMessage): Promise<void> {
    this.pet.emitEvent({
      type: "thinking",
      value: "start"
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

      if (reply.trim()) {
        await this.telegram.send({
          kind: "text",
          text: reply,
          chatId: inbound.chatId
        });
      }
      this.lastUserAt = new Date().toISOString();
    } finally {
      this.pet.emitEvent({
        type: "thinking",
        value: "stop"
      });
    }
  }

  private syncPetWindow(): void {
    const config = this.getConfig().pet;
    if (!config.enabled) {
      this.pet.close();
      return;
    }

    const modelDirInput = config.modelDir.trim();
    if (!modelDirInput) {
      this.pet.close();
      return;
    }

    const modelDir = path.isAbsolute(modelDirInput)
      ? modelDirInput
      : path.join(app.getAppPath(), modelDirInput);

    if (!existsSync(modelDir)) {
      this.pet.close();
      return;
    }

    this.pet.open({
      modelDir,
      alwaysOnTop: config.alwaysOnTop
    });
  }

  private async syncGlobalPetPushToTalk(): Promise<void> {
    if (!this.shouldEnableGlobalPetPushToTalk()) {
      this.globalPtt.stop();
      if (this.petPttRecording) {
        this.pet.emitEvent({
          type: "ptt",
          state: "cancel",
          reason: "桌宠语音已关闭"
        });
      }
      this.petPttRecording = false;
      return;
    }

    if (!this.ensureGlobalPttPermission()) {
      this.globalPtt.stop();
      this.petPttRecording = false;
      if (this.pet.isOnline()) {
        this.pet.emitEvent({
          type: "ptt",
          state: "cancel",
          reason: "请在系统设置中为 Yobi 打开辅助功能权限后再试。"
        });
      }
      return;
    }

    try {
      await this.globalPtt.start({
        hotkey: this.getConfig().ptt.hotkey,
        onPhase: (phase) => {
          void this.handleGlobalPetPushToTalkPhase(phase);
        }
      });
    } catch (error) {
      this.globalPtt.stop();
      this.petPttRecording = false;

      const reason = error instanceof Error ? error.message : "全局按住说话启动失败";
      if (this.pet.isOnline()) {
        this.pet.emitEvent({
          type: "ptt",
          state: "cancel",
          reason
        });
      }
    }
  }

  private shouldEnableGlobalPetPushToTalk(): boolean {
    const config = this.getConfig();
    return config.pet.enabled && config.ptt.enabled && this.pet.isOnline();
  }

  private async handleGlobalPetPushToTalkPhase(phase: GlobalPttPhase): Promise<void> {
    if (!this.shouldEnableGlobalPetPushToTalk()) {
      this.petPttRecording = false;
      return;
    }

    if (!this.ensureGlobalPttPermission()) {
      if (phase === "down") {
        this.pet.emitEvent({
          type: "ptt",
          state: "cancel",
          reason: "缺少辅助功能权限，无法监听全局快捷键。"
        });
      }
      this.petPttRecording = false;
      return;
    }

    if (!this.voiceRouter.isAlibabaSttReady()) {
      if (phase === "down") {
        this.pet.emitEvent({
          type: "ptt",
          state: "cancel",
          reason: "阿里语音识别未启用"
        });
      }
      this.petPttRecording = false;
      return;
    }

    if (phase === "down") {
      if (this.petPttRecording) {
        return;
      }

      this.petPttRecording = true;
      this.pet.emitEvent({
        type: "ptt",
        state: "start"
      });
      return;
    }

    if (!this.petPttRecording) {
      return;
    }

    this.petPttRecording = false;
    this.pet.emitEvent({
      type: "ptt",
      state: "stop"
    });
  }

  private ensureGlobalPttPermission(): boolean {
    if (process.platform !== "darwin") {
      return true;
    }

    let granted = false;
    try {
      granted = systemPreferences.isTrustedAccessibilityClient(false);
    } catch {
      granted = false;
    }

    this.systemPermissions.accessibility = granted ? "granted" : "denied";
    return granted;
  }

  private async emitPetSpeech(text: string): Promise<void> {
    const normalized = text.trim();
    if (!normalized || !this.getConfig().realtimeVoice.enabled || !this.pet.isOnline()) {
      return;
    }

    try {
      const config = this.getConfig();
      const audio = await this.voiceRouter.synthesize({
        text: normalized,
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
      console.warn("[pet] speech synthesis failed:", error);
    }
  }

  private emitPetTalkingReply(text: string): void {
    this.pet.emitEvent({
      type: "talking",
      value: "talking"
    });
    void this.emitPetSpeech(text);
  }

  private syncRealtimeVoice(): void {
    if (this.getConfig().realtimeVoice.enabled) {
      this.realtimeVoice.start();
      return;
    }

    this.realtimeVoice.stop();
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
      this.lastSilenceHandledAt = null;
      return;
    }

    if (!this.lastUserAt) {
      return;
    }

    const now = Date.now();
    const silenceMs = now - new Date(this.lastUserAt).getTime();

    if (silenceMs < proactiveConfig.silenceThresholdMs) {
      this.lastSilenceHandledAt = null;
      return;
    }

    if (this.lastSilenceHandledAt === this.lastUserAt) {
      return;
    }

    this.lastSilenceHandledAt = this.lastUserAt;
    await this.handleProactive({
      trigger: {
        type: "silence",
        detail: `用户已沉默 ${Math.floor(silenceMs / 60000)} 分钟`
      }
    });
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

    await this.conversation.rememberAssistantMessage({
      threadId: PRIMARY_THREAD_ID,
      resourceId: PRIMARY_RESOURCE_ID,
      channel: "console",
      text: decision.message,
      metadata: {
        proactive: true
      }
    });

    try {
      const config = this.getConfig();
      const audio = await this.voiceRouter.synthesize({
        text: decision.message,
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
    this.lastProactiveAt = new Date().toISOString();
  }

  private async collectStatus(): Promise<AppStatus> {
    this.refreshSystemPermissions();
    const openclawStatus = this.openclawRuntime.getStatus();
    return {
      bootedAt: this.bootedAt,
      telegramConnected: this.telegram.isConnected(),
      lastUserAt: this.lastUserAt,
      lastProactiveAt: this.lastProactiveAt,
      historyCount: await this.memory.countHistory({
        resourceId: PRIMARY_RESOURCE_ID,
        threadId: PRIMARY_THREAD_ID
      }),
      keepAwakeActive: this.keepAwake.isActive(),
      pendingReminders: this.reminderService.count(),
      petOnline: this.pet.isOnline(),
      openclawOnline: openclawStatus.online,
      openclawStatus: openclawStatus.message,
      systemPermissions: {
        ...this.systemPermissions
      }
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

    if (JSON.stringify(previousConfig.tools.mcp) !== JSON.stringify(nextConfig.tools.mcp)) {
      await this.runConfigSideEffect("重连 MCP 工具", 20_000, async () => {
        await this.toolRegistry.unregisterBySource("mcp");
        await this.mcpManager.dispose();
        await this.mcpManager.init(this.toolRegistry);
      });
    }

    if (JSON.stringify(previousConfig.openclaw) !== JSON.stringify(nextConfig.openclaw)) {
      await this.runConfigSideEffect("重启 OpenClaw", 20_000, async () => {
        await this.openclawRuntime.start(nextConfig);
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
      previousConfig.telegram.botToken !== nextConfig.telegram.botToken ||
      previousConfig.telegram.chatId !== nextConfig.telegram.chatId
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

  private refreshSystemPermissions(): void {
    this.systemPermissions = {
      accessibility: this.getSystemPermissionState("accessibility"),
      microphone: this.getSystemPermissionState("microphone"),
      screenCapture: this.getSystemPermissionState("screenCapture")
    };
  }

  private getSystemPermissionState(permission: SystemPermissionKey): PermissionState {
    if (permission === "accessibility") {
      return this.getAccessibilityPermissionState();
    }

    if (permission === "microphone") {
      return this.getMediaPermissionState("microphone");
    }

    return this.getMediaPermissionState("screen");
  }

  private getAccessibilityPermissionState(): PermissionState {
    if (process.platform !== "darwin") {
      return "granted";
    }

    try {
      return systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied";
    } catch {
      return "unknown";
    }
  }

  private getMediaPermissionState(permission: MediaPermissionKey): PermissionState {
    try {
      const status = this.getMediaAccessRawStatus(permission);
      return this.normalizeMediaPermissionState(status);
    } catch {
      return "unknown";
    }
  }

  private getMediaAccessRawStatus(permission: MediaPermissionKey): string {
    return systemPreferences.getMediaAccessStatus(permission);
  }

  private normalizeMediaPermissionState(raw: string): PermissionState {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "granted") {
      return "granted";
    }

    if (normalized === "denied" || normalized === "restricted") {
      return "denied";
    }

    return "unknown";
  }

  private async tryRequestScreenCapturePermissionOnMac(): Promise<void> {
    if (process.platform !== "darwin") {
      return;
    }

    try {
      await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: {
          width: 1,
          height: 1
        }
      });
    } catch (error) {
      console.warn("[runtime] request screen capture permission failed:", error);
    }
  }

  private async resolveCurrentBundleId(): Promise<string | null> {
    if (process.platform !== "darwin") {
      return null;
    }

    const marker = "/Contents/MacOS/";
    const markerIndex = process.execPath.indexOf(marker);
    if (markerIndex <= 0) {
      return null;
    }

    const appBundlePath = process.execPath.slice(0, markerIndex);
    const infoPlistPath = path.join(appBundlePath, "Contents", "Info");
    try {
      const { stdout } = await execFileAsync("defaults", [
        "read",
        infoPlistPath,
        "CFBundleIdentifier"
      ]);
      const bundleId = stdout.trim();
      return bundleId || null;
    } catch {
      return null;
    }
  }

  private resolveSystemPermissionSettingsTarget(permission: SystemPermissionKey): string | null {
    if (process.platform === "darwin") {
      const map: Record<SystemPermissionKey, string> = {
        accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        screenCapture: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
      };
      return map[permission];
    }

    if (process.platform === "win32") {
      const map: Record<SystemPermissionKey, string> = {
        accessibility: "ms-settings:easeofaccess",
        microphone: "ms-settings:privacy-microphone",
        screenCapture: "ms-settings:privacy"
      };
      return map[permission];
    }

    return null;
  }

  private async containsModel3JsonFile(dir: string): Promise<boolean> {
    const entries = await readdir(dir, {
      withFileTypes: true
    });

    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".model3.json")) {
        return true;
      }

      if (entry.isDirectory()) {
        const nested = path.join(dir, entry.name);
        if (await this.containsModel3JsonFile(nested)) {
          return true;
        }
      }
    }

    return false;
  }

  private normalizeModelDirectoryName(input: string): string {
    const normalized = input.trim().replace(/[^a-zA-Z0-9_-]+/g, "-");
    if (normalized) {
      return normalized.toLowerCase();
    }

    return `model-${Date.now()}`;
  }
}

export const runtime = new CompanionRuntime();
