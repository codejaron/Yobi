import path from "node:path";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { app } from "electron";
import type { AppConfig } from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import { AppLogger } from "@main/services/logger";
const logger = new AppLogger(new CompanionPaths());
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

interface PetServiceInput {
  paths: CompanionPaths;
  getConfig: () => AppConfig;
  pet: PetWindowController;
  voiceRouter: VoiceProviderRouter;
  realtimeVoice: RealtimeVoiceService;
  globalPtt: GlobalPetPushToTalkService;
  systemPermissionsService: SystemPermissionsService;
  channelRouter: ChannelRouter;
  primaryResourceId: string;
  primaryThreadId: string;
  chatReplyTimeoutMs: number;
  withTimeout: <T>(promise: Promise<T>, timeoutMs: number, label: string) => Promise<T>;
  onStatusChange?: () => void | Promise<void>;
}

export class PetService {
  private petPttRecording = false;

  constructor(private readonly input: PetServiceInput) {}

  isPetOnline(): boolean {
    return this.input.pet.isOnline();
  }

  stop(): void {
    this.input.pet.close();
    this.input.globalPtt.stop();
    this.petPttRecording = false;
    this.input.realtimeVoice.stop();
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

  async chatFromPet(text: string): Promise<{ replyText: string }> {
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
          resourceId: this.input.primaryResourceId,
          threadId: this.input.primaryThreadId
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
  }): Promise<{
    text: string;
  }> {
    const pcm16Base64 = typeof input.pcm16Base64 === "string" ? input.pcm16Base64.trim() : "";
    if (!pcm16Base64) {
      throw new Error("录音数据为空。");
    }

    if (!this.input.voiceRouter.isAlibabaSttReady()) {
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
    const text = await this.input.voiceRouter.transcribePcm16({
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
    if (!this.input.voiceRouter.isAlibabaSttReady()) {
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
      : path.join(app.getAppPath(), modelDirInput);

    if (!existsSync(modelDir)) {
      this.input.pet.close();
      return;
    }

    this.input.pet.open({
      modelDir,
      alwaysOnTop: config.alwaysOnTop
    });
  }

  async syncGlobalPetPushToTalk(): Promise<void> {
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
      await this.input.globalPtt.start({
        hotkey: this.input.getConfig().ptt.hotkey,
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
    if (this.input.getConfig().realtimeVoice.enabled) {
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
    return config.pet.enabled && config.ptt.enabled && this.input.pet.isOnline();
  }

  private async handleGlobalPetPushToTalkPhase(phase: GlobalPttPhase): Promise<void> {
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

    if (!this.input.voiceRouter.isAlibabaSttReady()) {
      if (phase === "down") {
        this.input.pet.emitEvent({
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

  private async emitPetSpeech(text: string): Promise<void> {
    const normalized = text.trim();
    if (!normalized || !this.input.getConfig().realtimeVoice.enabled || !this.input.pet.isOnline()) {
      return;
    }

    try {
      const config = this.input.getConfig();
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
        type: "speech",
        audioBase64: audio.toString("base64"),
        mimeType: "audio/mpeg"
      });
    } catch (error) {
      logger.warn("pet", "speech-synthesis-failed", undefined, error);
    }
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
}
