import type { AppConfig } from "@shared/types";
import { AlibabaVoiceService } from "./alibaba-voice";
import { VoiceService, type VoiceConfig } from "./voice";
import { WhisperModelManager } from "./whisper-model-manager";
import { WhisperLocalService } from "./whisper-local";

const DEFAULT_ALIBABA_ASR_MODEL = "fun-asr-realtime";
const DEFAULT_ALIBABA_TTS_MODEL = "cosyvoice-v3-flash";
const DEFAULT_ALIBABA_TTS_VOICE = "longxiaochun_v3";

function hasAlibabaCredentials(config: AppConfig): boolean {
  return config.alibabaVoice.apiKey.trim().length > 0;
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
    if (config.voice.asrProvider !== "whisper-local") {
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
    const config = this.getConfig();
    return config.voice.asrProvider === "alibaba" && hasAlibabaCredentials(config);
  }

  getWhisperFailureReason(): string | null {
    return this.whisperLocal.getLoadErrorMessage();
  }

  isAsrReady(): boolean {
    const config = this.getConfig();
    if (config.voice.asrProvider === "whisper-local") {
      return this.whisperLocal.isReady();
    }

    if (config.voice.asrProvider === "alibaba") {
      return hasAlibabaCredentials(config);
    }

    return false;
  }

  async transcribePcm16(input: {
    pcm: Buffer;
    sampleRate: number;
  }): Promise<string> {
    const config = this.getConfig();
    if (config.voice.asrProvider === "whisper-local") {
      return this.whisperLocal.transcribe(input);
    }

    if (config.voice.asrProvider === "alibaba") {
      if (!hasAlibabaCredentials(config)) {
        throw new Error("阿里语音识别未就绪，请先填写 API Key。");
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

    throw new Error("未启用任何语音识别引擎。请在设置中选择本地 Whisper 或阿里百炼。");
  }

  async synthesize(input: {
    text: string;
    edgeConfig: VoiceConfig;
  }): Promise<Buffer> {
    const config = this.getConfig();
    if (config.voice.ttsProvider !== "alibaba") {
      return this.edgeVoice.synthesize({
        text: input.text,
        config: input.edgeConfig
      });
    }

    if (!hasAlibabaCredentials(config)) {
      throw new Error("阿里语音合成未就绪，请先填写 API Key。");
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
