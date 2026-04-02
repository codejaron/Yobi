import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import type {
  AppConfig,
  ChatAttachment,
  EmotionalState,
  KernelStateDocument,
  VoiceInputContext,
  VoiceTranscriptionResult
} from "@shared/types";
import { DEFAULT_PET_EMOTION_CONFIG } from "@shared/pet-emotion";
import { CompanionPaths } from "@main/storage/paths";
import { appLogger as logger } from "@main/runtime/singletons";
import { ChannelRouter } from "@main/channels/router";
import { PetWindowController } from "@main/pet/pet-window";
import { RealtimeVoiceService } from "@main/services/realtime-voice";
import {
  GlobalPetPushToTalkService,
  type GlobalPttPhase
} from "@main/services/global-ptt";
import { VoiceProviderRouter } from "@main/services/voice-router";
import { SystemPermissionsService } from "@main/services/system-permissions";
import { extractEmotionTag } from "@main/core/emotion-tags";
import { StateStore } from "@main/kernel/state-store";
import { shouldPublishEmotionState } from "@main/pet/emotion-state-sync";
import { getPetModelMetadata as readPetModelMetadata } from "@main/pet/pet-model-metadata";
import { shouldUseUnifiedRealtimeVoice } from "@main/services/pet-voice-mode";
import type { VoiceSessionEvent } from "@shared/types";
import type { PetModelMetadata } from "@shared/ipc";
import { resolveAssistantSpeechRoute } from "@main/services/assistant-speech-policy";
import type { NativeAudioCaptureBackend } from "@main/services/native-audio-capture";

const require = createRequire(import.meta.url);

interface PetServiceInput {
  paths: CompanionPaths;
  getConfig: () => AppConfig;
  pet: PetWindowController;
  stateStore: StateStore;
  voiceRouter: VoiceProviderRouter;
  realtimeVoice: RealtimeVoiceService;
  globalPtt: GlobalPetPushToTalkService;
  nativeAudioCapture?: Pick<NativeAudioCaptureBackend, "isNativeSupported" | "warmup" | "prepare">;
  systemPermissionsService: SystemPermissionsService;
  channelRouter: ChannelRouter;
  primaryResourceId: string;
  primaryThreadId: string;
  chatReplyTimeoutMs: number;
  withTimeout: <T>(promise: Promise<T>, timeoutMs: number, label: string) => Promise<T>;
  captureCompanionSpeechContext?: () => Promise<ChatAttachment[]>;
  onStatusChange?: () => void | Promise<void>;
}

export class PetService {
  private petPttRecording = false;
  private latestEmotionalState: EmotionalState = cloneEmotionalState(DEFAULT_PET_EMOTION_CONFIG.defaultEmotion);
  private lastPublishedEmotionalState: EmotionalState | null = null;
  private lastPublishedAtMs = 0;
  private captureCompanionSpeechContext: (() => Promise<ChatAttachment[]>) | null = null;
  private nativeCaptureWarmupPromise: Promise<void> | null = null;

  constructor(private readonly input: PetServiceInput) {
    this.captureCompanionSpeechContext = input.captureCompanionSpeechContext ?? null;
    this.input.stateStore.subscribe((state) => {
      this.handleKernelStateSnapshot(state);
    }, { emitCurrent: true });
    this.input.realtimeVoice.onEvent((event) => {
      this.handleRealtimeVoiceEvent(event);
    });
  }

  isPetOnline(): boolean {
    return this.input.pet.isOnline();
  }

  stop(): void {
    this.input.pet.close();
    this.input.globalPtt.stop();
    this.petPttRecording = false;
    this.input.realtimeVoice.stop();
  }

  setCompanionCaptureContextProvider(provider: (() => Promise<ChatAttachment[]>) | null): void {
    this.captureCompanionSpeechContext = provider;
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

    await mkdir(this.input.paths.modelsDir, {
      recursive: true
    });

    const managedModelsDir = path.resolve(this.input.paths.modelsDir);
    if (resolvedSourceDir === managedModelsDir) {
      throw new Error("请选择具体模型文件夹，不要选择 models 根目录。");
    }

    const baseName = this.normalizeModelDirectoryName(path.basename(resolvedSourceDir));
    let targetDir = path.join(this.input.paths.modelsDir, baseName);
    if (existsSync(targetDir)) {
      targetDir = path.join(this.input.paths.modelsDir, `${baseName}-${Date.now()}`);
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

  getPetModelMetadata(input?: { modelDir?: string }): PetModelMetadata {
    const configuredModelDir = input?.modelDir?.trim() || this.input.getConfig().pet.modelDir.trim();
    if (!configuredModelDir) {
      return {
        expressions: []
      };
    }

    const modelDir = path.isAbsolute(configuredModelDir)
      ? configuredModelDir
      : path.join(resolveElectronAppPath(), configuredModelDir);

    if (!existsSync(modelDir)) {
      return {
        expressions: []
      };
    }

    return readPetModelMetadata(modelDir);
  }

  applyPetExpression(input: { id?: string }): { applied: boolean } {
    if (!this.input.pet.isOnline()) {
      return {
        applied: false
      };
    }

    this.input.pet.emitEvent({
      type: "expression",
      id: typeof input.id === "string" ? input.id : ""
    });

    return {
      applied: true
    };
  }

  async chatFromPet(
    text: string,
    voiceContext?: VoiceInputContext,
    attachments: ChatAttachment[] = []
  ): Promise<{ replyText: string }> {
    const normalized = text.trim();
    if (!normalized) {
      return { replyText: "" };
    }

    this.input.pet.emitEvent({
      type: "thinking",
      value: "start"
    });

    try {
      const reply = await this.input.withTimeout(
        this.input.channelRouter.handleConsole({
          text: normalized,
          attachments,
          resourceId: this.input.primaryResourceId,
          threadId: this.input.primaryThreadId,
          voiceContext
        }),
        this.input.chatReplyTimeoutMs,
        "LLM 回复超时"
      );

      const parsed = extractEmotionTag(reply);
      const replyText = parsed.cleanedText.trim() || "我这次没有生成有效回复，请重试一次。";

      if (parsed.emotion) {
        this.input.pet.emitEvent({
          type: "emotion",
          value: parsed.emotion
        });
      }

      this.emitPetTalkingReply(replyText);

      return {
        replyText
      };
    } finally {
      this.input.pet.emitEvent({
        type: "thinking",
        value: "stop"
      });
    }
  }

  async transcribeVoiceInput(input: {
    pcm16Base64?: string;
    sampleRate?: number;
  }): Promise<VoiceTranscriptionResult> {
    const pcm16Base64 = typeof input.pcm16Base64 === "string" ? input.pcm16Base64.trim() : "";
    if (!pcm16Base64) {
      throw new Error("录音数据为空。");
    }

    if (!this.input.voiceRouter.isAsrReady()) {
      throw new Error("语音识别尚未就绪，请在设置里启用本地 SenseVoice 或阿里语音，并确认模型已下载完成。");
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
    return this.input.voiceRouter.transcribePcm16({
      pcm,
      sampleRate
    });
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
    if (!this.input.voiceRouter.isAsrReady()) {
      return {
        sent: false,
        text: "",
        message: "语音识别尚未就绪"
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

    const companionAttachments = await this.captureCompanionSpeechContext?.().catch(() => []) ?? [];
    let replied: { replyText: string };
    try {
      replied = await this.chatFromPet(
        text,
        transcribed.metadata
          ? {
              provider: this.input.getConfig().voice.asrProvider,
              metadata: transcribed.metadata
            }
          : undefined,
        companionAttachments
      );
    } catch (error) {
      return {
        sent: false,
        text,
        metadata: transcribed.metadata,
        message: error instanceof Error ? error.message.trim() || "语音处理失败，请稍后重试。" : "语音处理失败，请稍后重试。"
      };
    }
    return {
      sent: true,
      text,
      metadata: transcribed.metadata,
      replyText: replied.replyText
    };
  }

  syncPetWindow(): void {
    const config = this.input.getConfig().pet;
    if (!config.enabled) {
      this.input.pet.close();
      return;
    }

    const modelDirInput = config.modelDir.trim();
    if (!modelDirInput) {
      this.input.pet.close();
      return;
    }

    const modelDir = path.isAbsolute(modelDirInput)
      ? modelDirInput
      : path.join(resolveElectronAppPath(), modelDirInput);

    if (!existsSync(modelDir)) {
      this.input.pet.close();
      return;
    }

    this.input.pet.open({
      modelDir,
      alwaysOnTop: config.alwaysOnTop
    });

    this.publishEmotionState({ force: true });
    this.input.pet.emitEvent({
      type: "expression",
      id: config.expressionId
    });
  }

  async syncGlobalPetPushToTalk(): Promise<void> {
    if (shouldUseUnifiedRealtimeVoice(this.input.getConfig())) {
      this.input.globalPtt.stop();
      this.petPttRecording = false;
      return;
    }

    if (!this.shouldEnableGlobalPetPushToTalk()) {
      this.input.globalPtt.stop();
      if (this.petPttRecording) {
        this.input.pet.emitEvent({
          type: "ptt",
          state: "cancel",
          reason: "桌宠语音已关闭"
        });
      }
      this.petPttRecording = false;
      if (this.input.pet.isOnline() && !this.input.voiceRouter.isAsrReady()) {
        this.input.pet.emitEvent({
          type: "ptt",
          state: "cancel",
          reason: "语音识别尚未就绪，已跳过全局按住说话启动"
        });
      }
      return;
    }

    if (!this.input.systemPermissionsService.ensureGlobalPttPermission()) {
      this.input.globalPtt.stop();
      this.petPttRecording = false;
      if (this.input.pet.isOnline()) {
        this.input.pet.emitEvent({
          type: "ptt",
          state: "cancel",
          reason: "请在系统设置中为 Yobi 打开辅助功能权限后再试。"
        });
      }
      await this.notifyStatusChange();
      return;
    }

    try {
      void this.warmupGlobalPttCapture();
      await this.input.globalPtt.start({
        hotkey: this.input.getConfig().ptt.hotkey,
        onPrepare: () => {
          void this.prepareGlobalPttCapture();
        },
        onPhase: (phase) => {
          void this.handleGlobalPetPushToTalkPhase(phase);
        }
      });
    } catch (error) {
      this.input.globalPtt.stop();
      this.petPttRecording = false;

      const reason = error instanceof Error ? error.message : "全局按住说话启动失败";
      if (this.input.pet.isOnline()) {
        this.input.pet.emitEvent({
          type: "ptt",
          state: "cancel",
          reason
        });
      }
    }
  }

  syncRealtimeVoice(): void {
    if (shouldUseUnifiedRealtimeVoice(this.input.getConfig())) {
      this.input.realtimeVoice.start();
      return;
    }

    this.input.realtimeVoice.stop();
  }

  emitPetTalkingReply(text: string): void {
    this.input.pet.emitEvent({
      type: "talking",
      value: "talking"
    });
    void this.emitPetSpeech(text);
  }

  private shouldEnableGlobalPetPushToTalk(): boolean {
    const config = this.input.getConfig();
    return (
      config.pet.enabled &&
      config.ptt.enabled &&
      this.input.pet.isOnline() &&
      this.input.voiceRouter.isAsrReady()
    );
  }

  private async handleGlobalPetPushToTalkPhase(phase: GlobalPttPhase): Promise<void> {
    if (shouldUseUnifiedRealtimeVoice(this.input.getConfig())) {
      await this.input.realtimeVoice.handlePttPhase(phase);
      return;
    }

    if (!this.shouldEnableGlobalPetPushToTalk()) {
      this.petPttRecording = false;
      return;
    }

    if (!this.input.systemPermissionsService.ensureGlobalPttPermission()) {
      if (phase === "down") {
        this.input.pet.emitEvent({
          type: "ptt",
          state: "cancel",
          reason: "缺少辅助功能权限，无法监听全局快捷键。"
        });
      }
      this.petPttRecording = false;
      await this.notifyStatusChange();
      return;
    }

    if (!this.input.voiceRouter.isAsrReady()) {
      if (phase === "down") {
        this.input.pet.emitEvent({
          type: "ptt",
          state: "cancel",
          reason: "语音识别尚未就绪"
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
      this.input.pet.emitEvent({
        type: "ptt",
        state: "start"
      });
      return;
    }

    if (!this.petPttRecording) {
      return;
    }

    this.petPttRecording = false;
    this.input.pet.emitEvent({
      type: "ptt",
      state: "stop"
    });
  }

  private warmupGlobalPttCapture(): Promise<void> {
    const capture = this.input.nativeAudioCapture;
    if (capture?.isNativeSupported() !== true || typeof capture.warmup !== "function") {
      return Promise.resolve();
    }

    if (this.nativeCaptureWarmupPromise) {
      return this.nativeCaptureWarmupPromise;
    }

    const promise = capture
      .warmup()
      .catch((error) => {
        logger.warn("pet-service", "global-ptt-native-warmup-failed", undefined, error);
      })
      .finally(() => {
        if (this.nativeCaptureWarmupPromise === promise) {
          this.nativeCaptureWarmupPromise = null;
        }
      });

    this.nativeCaptureWarmupPromise = promise;
    return promise;
  }

  private prepareGlobalPttCapture(): Promise<void> {
    const capture = this.input.nativeAudioCapture;
    if (capture?.isNativeSupported() !== true || typeof capture.prepare !== "function") {
      return this.warmupGlobalPttCapture();
    }

    return capture.prepare().catch((error) => {
      logger.warn("pet-service", "global-ptt-native-prepare-failed", undefined, error);
    });
  }

  private async emitPetSpeech(text: string): Promise<void> {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }

    const config = this.input.getConfig();
    const route = resolveAssistantSpeechRoute({
      speechReplyEnabled: config.realtimeVoice.speechReplyEnabled,
      petOnline: this.input.pet.isOnline(),
      unifiedRealtimeVoice: shouldUseUnifiedRealtimeVoice(config),
      realtimeSessionActive: this.input.realtimeVoice.isActive()
    });

    if (route === "none") {
      return;
    }

    if (route === "pet") {
      try {
        const audio = await this.input.voiceRouter.synthesize({
          text: normalized,
          edgeConfig: {
            voice: config.voice.ttsVoice,
            rate: config.voice.ttsRate,
            pitch: config.voice.ttsPitch,
            requestTimeoutMs: config.voice.requestTimeoutMs,
            retryCount: config.voice.retryCount
          }
        });

        this.input.pet.emitEvent({
          type: "speech-enqueue",
          chunkId: `pet-speech-${randomUUID()}`,
          audioBase64: audio.toString("base64"),
          mimeType: "audio/mpeg",
          text: normalized,
          generation: 0
        });
      } catch (error) {
        logger.warn("pet", "speech-synthesis-failed", undefined, error);
      }
      return;
    }

    try {
      await this.input.realtimeVoice.speakText(normalized);
    } catch (error) {
      logger.warn("pet", "speech-synthesis-failed", undefined, error);
    }
  }

  private handleKernelStateSnapshot(state: KernelStateDocument): void {
    this.latestEmotionalState = cloneEmotionalState(state.emotional);
    this.publishEmotionState();
  }

  private publishEmotionState(input?: { force?: boolean }): void {
    if (!this.input.pet.isOnline()) {
      return;
    }

    const nowMs = Date.now();
    const syncConfig = DEFAULT_PET_EMOTION_CONFIG.stateSync;
    if (
      !shouldPublishEmotionState({
        previous: this.lastPublishedEmotionalState,
        next: this.latestEmotionalState,
        epsilon: syncConfig.epsilon,
        heartbeatMs: syncConfig.heartbeatMs,
        nowMs,
        lastPublishedAtMs: this.lastPublishedAtMs,
        force: input?.force === true
      })
    ) {
      return;
    }

    const next = cloneEmotionalState(this.latestEmotionalState);
    this.input.pet.emitEvent({
      type: "emotion-state",
      emotional: next
    });
    this.lastPublishedEmotionalState = next;
    this.lastPublishedAtMs = nowMs;
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

  private async notifyStatusChange(): Promise<void> {
    await this.input.onStatusChange?.();
  }

  private handleRealtimeVoiceEvent(event: VoiceSessionEvent): void {
    if (!this.input.pet.isOnline()) {
      return;
    }

    if (event.type === "state") {
      this.input.pet.emitEvent({
        type: "voice-state",
        phase: event.state.phase,
        mode: event.state.mode
      });
      return;
    }
  }
}

function resolveElectronAppPath(): string {
  if (!process.versions.electron) {
    return process.cwd();
  }

  const electron = require("electron") as { app?: { getAppPath?: () => string } };
  return electron.app?.getAppPath?.() ?? process.cwd();
}

function cloneEmotionalState(state: EmotionalState): EmotionalState {
  return {
    dimensions: {
      ...state.dimensions
    },
    ekman: {
      ...state.ekman
    },
    connection: state.connection,
    sessionWarmth: state.sessionWarmth
  };
}
