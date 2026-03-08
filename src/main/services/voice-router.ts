import type { AppConfig } from "@shared/types";
import { AlibabaVoiceService } from "./alibaba-voice";
import { VoiceService, type VoiceConfig } from "./voice";
import { WhisperModelManager } from "./whisper-model-manager";
import { WhisperLocalService } from "./whisper-local";

const DEFAULT_ALIBABA_ASR_MODEL = "fun-asr-realtime";
const DEFAULT_ALIBABA_TTS_MODEL = "cosyvoice-v3-flash";
const DEFAULT_ALIBABA_TTS_VOICE = "longxiaochun_v3";

function hasAlibabaVoiceCredentials(config: AppConfig): boolean {
  return config.alibabaVoice.enabled && config.alibabaVoice.apiKey.trim().length > 0;
}

function resolveAlibabaAsrModel(config: AppConfig): string {
  const candidate = config.alibabaVoice.asrModel.trim();
  return candidate || DEFAULT_ALIBABA_ASR_MODEL;
}

function resolveAlibabaTtsModel(config: AppConfig): string {
  const candidate = config.alibabaVoice.ttsModel.trim();
  return candidate || DEFAULT_ALIBABA_TTS_MODEL;
}

function resolveAlibabaTtsVoice(config: AppConfig): string {
  const candidate = config.alibabaVoice.ttsVoice.trim();
  return candidate || DEFAULT_ALIBABA_TTS_VOICE;
}

export class VoiceProviderRouter {
  constructor(
    private readonly getConfig: () => AppConfig,
    private readonly edgeVoice: VoiceService = new VoiceService(),
    private readonly alibabaVoice: AlibabaVoiceService = new AlibabaVoiceService(),
    private readonly whisperLocal: WhisperLocalService = new WhisperLocalService()
  ) {}

  syncLocalAsrState(modelsDir: string): void {
    const config = this.getConfig();
    if (!config.whisperLocal.enabled) {
      this.whisperLocal.reset();
      return;
    }

    const manager = new WhisperModelManager(modelsDir);
    const modelSize = config.whisperLocal.modelSize;
    if (!manager.isModelDownloaded(modelSize)) {
      this.whisperLocal.reset();
      return;
    }

    this.whisperLocal.configureModel(manager.getModelPath(modelSize));
  }

  isAlibabaSttReady(): boolean {
    return hasAlibabaVoiceCredentials(this.getConfig());
  }

  getWhisperFailureReason(): string | null {
    return this.whisperLocal.getLoadErrorMessage();
  }

  isAsrReady(): boolean {
    const config = this.getConfig();
    if (config.whisperLocal.enabled) {
      return this.whisperLocal.isReady();
    }

    return this.isAlibabaSttReady();
  }

  async transcribePcm16(input: {
    pcm: Buffer;
    sampleRate: number;
  }): Promise<string> {
    const config = this.getConfig();
    if (config.whisperLocal.enabled) {
      return this.whisperLocal.transcribe(input);
    }

    if (!hasAlibabaVoiceCredentials(config)) {
      throw new Error("未启用任何语音识别引擎。请在设置中开启本地 Whisper 或配置阿里语音。");
    }

    return this.alibabaVoice.transcribe({
      apiKey: config.alibabaVoice.apiKey.trim(),
      region: config.alibabaVoice.region,
      pcm: input.pcm,
      sampleRate: input.sampleRate,
      model: resolveAlibabaAsrModel(config),
      timeoutMs: Math.max(6000, config.voice.requestTimeoutMs)
    });
  }

  async synthesize(input: {
    text: string;
    edgeConfig: VoiceConfig;
  }): Promise<Buffer> {
    const config = this.getConfig();
    if (!hasAlibabaVoiceCredentials(config)) {
      return this.edgeVoice.synthesize({
        text: input.text,
        config: input.edgeConfig
      });
    }

    return this.alibabaVoice.synthesize({
      apiKey: config.alibabaVoice.apiKey.trim(),
      region: config.alibabaVoice.region,
      text: input.text,
      model: resolveAlibabaTtsModel(config),
      voice: resolveAlibabaTtsVoice(config),
      timeoutMs: Math.max(6000, config.voice.requestTimeoutMs),
      retryCount: config.voice.retryCount
    });
  }
}
