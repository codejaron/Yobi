import type { AppConfig, VoiceTranscriptionResult } from "@shared/types";
import { AlibabaVoiceService } from "./alibaba-voice";
import { VoiceService, type VoiceConfig } from "./voice";
import { SenseVoiceModelManager } from "./sensevoice-model-manager";
import { SenseVoiceLocalService } from "./sensevoice-local";

const DEFAULT_ALIBABA_ASR_MODEL = "fun-asr-realtime";
const DEFAULT_ALIBABA_TTS_MODEL = "cosyvoice-v3-flash";
const DEFAULT_ALIBABA_TTS_VOICE = "longxiaochun_v3";

export interface StreamingAsrSession {
  pushPcm: (chunk: Buffer) => Promise<void>;
  flush: () => Promise<VoiceTranscriptionResult>;
  abort: () => Promise<void>;
}

export interface StreamingTtsSession {
  synthesizeChunk: (text: string) => Promise<Buffer>;
  close: () => Promise<void>;
}

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
    private readonly senseVoiceLocal: SenseVoiceLocalService = new SenseVoiceLocalService()
  ) {}

  syncLocalAsrState(modelsDir: string): void {
    const config = this.getConfig();
    if (config.voice.asrProvider !== "sensevoice-local") {
      this.senseVoiceLocal.reset();
      return;
    }

    const manager = new SenseVoiceModelManager(modelsDir);
    const modelName = config.senseVoiceLocal.modelName;
    if (!manager.isModelDownloaded(modelName)) {
      this.senseVoiceLocal.reset();
      return;
    }

    this.senseVoiceLocal.configureModel(manager.getModelPath(modelName));
  }

  isAlibabaSttReady(): boolean {
    const config = this.getConfig();
    return config.voice.asrProvider === "alibaba" && hasAlibabaCredentials(config);
  }

  getSenseVoiceFailureReason(): string | null {
    return this.senseVoiceLocal.getLoadErrorMessage();
  }

  isAsrReady(): boolean {
    const config = this.getConfig();
    if (config.voice.asrProvider === "sensevoice-local") {
      return this.senseVoiceLocal.isReady();
    }

    if (config.voice.asrProvider === "alibaba") {
      return hasAlibabaCredentials(config);
    }

    return false;
  }

  async transcribePcm16(input: {
    pcm: Buffer;
    sampleRate: number;
  }): Promise<VoiceTranscriptionResult> {
    const config = this.getConfig();
    if (config.voice.asrProvider === "sensevoice-local") {
      return this.senseVoiceLocal.transcribe(input);
    }

    if (config.voice.asrProvider === "alibaba") {
      if (!hasAlibabaCredentials(config)) {
        throw new Error("阿里语音识别未就绪，请先填写 API Key。");
      }

      const text = await this.alibabaVoice.transcribe({
        apiKey: config.alibabaVoice.apiKey.trim(),
        region: config.alibabaVoice.region,
        pcm: input.pcm,
        sampleRate: input.sampleRate,
        model: resolveAlibabaAsrModel(config),
        timeoutMs: Math.max(6000, config.voice.requestTimeoutMs)
      });
      return {
        text,
        metadata: null
      };
    }

    throw new Error("未启用任何语音识别引擎。请在设置中选择本地 SenseVoice 或阿里百炼。");
  }

  createStreamingAsrSession(input: {
    sampleRate: number;
    onPartial?: (text: string) => void;
  }): StreamingAsrSession {
    const config = this.getConfig();
    if (config.voice.asrProvider === "sensevoice-local") {
      return this.senseVoiceLocal.createStreamingSession(input);
    }

    if (config.voice.asrProvider === "alibaba") {
      if (!hasAlibabaCredentials(config)) {
        throw new Error("阿里语音识别未就绪，请先填写 API Key。");
      }

      return this.alibabaVoice.createStreamingAsrSession({
        apiKey: config.alibabaVoice.apiKey.trim(),
        region: config.alibabaVoice.region,
        sampleRate: input.sampleRate,
        model: resolveAlibabaAsrModel(config),
        timeoutMs: Math.max(6000, config.voice.requestTimeoutMs),
        onPartial: input.onPartial
      });
    }

    throw new Error("未启用任何流式语音识别引擎。");
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

  createStreamingTtsSession(input: {
    edgeConfig: VoiceConfig;
  }): StreamingTtsSession {
    return {
      synthesizeChunk: async (text: string) =>
        this.synthesize({
          text,
          edgeConfig: input.edgeConfig
        }),
      close: async () => undefined
    };
  }
}
