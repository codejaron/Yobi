import type { AppConfig } from "@shared/types";
import type { AppLogger } from "./logger";

// avr-vad's bundled v5 model only runs reliably at 512 samples/frame with the current onnxruntime build.
export const VOICE_ACTIVITY_FRAME_SAMPLES = 512;
export const VOICE_ACTIVITY_FRAME_BYTES = VOICE_ACTIVITY_FRAME_SAMPLES * 2;
const EMPTY_BUFFER: Buffer = Buffer.alloc(0);
const SAMPLE_RATE = 16_000;

export interface VoiceActivityDetectorConfig {
  vadThreshold: number;
  minSpeechMs: number;
  minSilenceMs: number;
}

export interface VoiceActivityChunkResult {
  probability: number;
  speechStarted: boolean;
  speechEnded: boolean;
  speaking: boolean;
}

export interface VoiceActivityDetector {
  processChunk(chunk: Buffer): Promise<VoiceActivityChunkResult>;
  reset(): void;
  dispose(): void;
}

export interface SileroVadRuntimeCallbacks {
  onFrameProcessed: (probability: number) => void;
  onSpeechStart: () => void;
  onSpeechRealStart: () => void;
  onSpeechEnd: () => void;
  onVADMisfire: () => void;
}

export interface SileroVadRuntime {
  start(): void;
  processAudio(frame: Float32Array): Promise<void>;
  reset(): void;
  destroy(): void;
}

type SileroVadRuntimeFactory = (
  callbacks: SileroVadRuntimeCallbacks,
  config: VoiceActivityDetectorConfig
) => Promise<SileroVadRuntime>;

interface CreateSileroVadProcessorOptions {
  createRuntime?: SileroVadRuntimeFactory;
}

interface CreateVoiceActivityDetectorInput {
  config: VoiceActivityDetectorConfig;
  logger: Pick<AppLogger, "warn">;
  createRuntime?: SileroVadRuntimeFactory;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, value));
}

function createDefaultChunkResult(
  probability = 0,
  speaking = false
): VoiceActivityChunkResult {
  return {
    probability,
    speechStarted: false,
    speechEnded: false,
    speaking
  };
}

function appendChunk(left: Buffer, right: Buffer): Buffer {
  if (left.length === 0) {
    return Buffer.from(right);
  }

  if (right.length === 0) {
    return left;
  }

  return Buffer.concat([left, right]);
}

function pcm16ToFloat32(frame: Buffer): Float32Array {
  const sampleCount = Math.floor(frame.length / 2);
  const output = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    output[index] = frame.readInt16LE(index * 2) / 0x8000;
  }
  return output;
}

function getFrameDurationMs(frameSamples: number): number {
  return (frameSamples / SAMPLE_RATE) * 1000;
}

export function getVoiceActivityDetectorConfig(
  realtimeVoice: Pick<AppConfig["realtimeVoice"], "vadThreshold" | "minSpeechMs" | "minSilenceMs">
): VoiceActivityDetectorConfig {
  return {
    vadThreshold: realtimeVoice.vadThreshold,
    minSpeechMs: realtimeVoice.minSpeechMs,
    minSilenceMs: realtimeVoice.minSilenceMs
  };
}

export function getSileroVadOptions(
  config: VoiceActivityDetectorConfig
): {
  model: "v5";
  sampleRate: number;
  frameSamples: number;
  positiveSpeechThreshold: number;
  negativeSpeechThreshold: number;
  minSpeechFrames: number;
  redemptionFrames: number;
  preSpeechPadFrames: number;
} {
  const positiveSpeechThreshold = clampNumber(config.vadThreshold, 0.05, 0.95);
  const frameSamples = VOICE_ACTIVITY_FRAME_SAMPLES;
  const frameDurationMs = getFrameDurationMs(frameSamples);

  return {
    model: "v5",
    sampleRate: SAMPLE_RATE,
    frameSamples,
    positiveSpeechThreshold,
    negativeSpeechThreshold: clampNumber(positiveSpeechThreshold - 0.15, 0.05, positiveSpeechThreshold),
    minSpeechFrames: Math.max(1, Math.ceil(config.minSpeechMs / frameDurationMs)),
    redemptionFrames: Math.max(1, Math.ceil(config.minSilenceMs / frameDurationMs)),
    preSpeechPadFrames: 0
  };
}

async function createAvrVadRuntime(
  callbacks: SileroVadRuntimeCallbacks,
  config: VoiceActivityDetectorConfig
): Promise<SileroVadRuntime> {
  const { RealTimeVAD } = await import("avr-vad");
  const vad = await RealTimeVAD.new({
    ...getSileroVadOptions(config),
    onFrameProcessed: (probabilities) => {
      callbacks.onFrameProcessed(probabilities.isSpeech);
    },
    onSpeechStart: callbacks.onSpeechStart,
    onSpeechRealStart: callbacks.onSpeechRealStart,
    onSpeechEnd: () => {
      callbacks.onSpeechEnd();
    },
    onVADMisfire: callbacks.onVADMisfire
  });

  return {
    start: () => {
      vad.start();
    },
    processAudio: async (frame) => {
      await vad.processAudio(frame);
    },
    reset: () => {
      vad.reset();
    },
    destroy: () => {
      vad.destroy();
    }
  };
}

class SileroVadProcessor implements VoiceActivityDetector {
  private bufferedPcm: Buffer = EMPTY_BUFFER;
  private runtime: SileroVadRuntime | null = null;
  private runtimePromise: Promise<SileroVadRuntime> | null = null;
  private currentCollector: VoiceActivityChunkResult | null = null;
  private speaking = false;
  private lastProbability = 0;
  private disposed = false;

  private readonly callbacks: SileroVadRuntimeCallbacks = {
    onFrameProcessed: (probability) => {
      this.lastProbability = clampNumber(probability, 0, 1);
      if (this.currentCollector) {
        this.currentCollector.probability = this.lastProbability;
      }
    },
    onSpeechStart: () => undefined,
    onSpeechRealStart: () => {
      this.speaking = true;
      if (this.currentCollector) {
        this.currentCollector.speechStarted = true;
      }
    },
    onSpeechEnd: () => {
      this.speaking = false;
      if (this.currentCollector) {
        this.currentCollector.speechEnded = true;
      }
    },
    onVADMisfire: () => undefined
  };

  constructor(
    private readonly config: VoiceActivityDetectorConfig,
    private readonly createRuntime: SileroVadRuntimeFactory
  ) {}

  static async create(
    config: VoiceActivityDetectorConfig,
    options?: CreateSileroVadProcessorOptions
  ): Promise<SileroVadProcessor> {
    const processor = new SileroVadProcessor(config, options?.createRuntime ?? createAvrVadRuntime);
    await processor.ensureRuntime();
    return processor;
  }

  async processChunk(chunk: Buffer): Promise<VoiceActivityChunkResult> {
    if (this.disposed || chunk.length === 0) {
      return createDefaultChunkResult(this.lastProbability, this.speaking);
    }

    this.bufferedPcm = appendChunk(this.bufferedPcm, chunk);
    if (this.bufferedPcm.length < VOICE_ACTIVITY_FRAME_BYTES) {
      return createDefaultChunkResult(this.lastProbability, this.speaking);
    }

    const runtime = await this.ensureRuntime();
    const result = createDefaultChunkResult(this.lastProbability, this.speaking);
    this.currentCollector = result;

    try {
      while (this.bufferedPcm.length >= VOICE_ACTIVITY_FRAME_BYTES) {
        const frameBuffer = this.bufferedPcm.subarray(0, VOICE_ACTIVITY_FRAME_BYTES);
        this.bufferedPcm = Buffer.from(this.bufferedPcm.subarray(VOICE_ACTIVITY_FRAME_BYTES));
        await runtime.processAudio(pcm16ToFloat32(frameBuffer));
      }
    } finally {
      this.currentCollector = null;
    }

    result.probability = this.lastProbability;
    result.speaking = this.speaking;
    return result;
  }

  reset(): void {
    this.bufferedPcm = EMPTY_BUFFER;
    this.speaking = false;
    this.lastProbability = 0;
    this.currentCollector = null;
    this.restartRuntime();
  }

  dispose(): void {
    this.disposed = true;
    this.bufferedPcm = EMPTY_BUFFER;
    this.speaking = false;
    this.lastProbability = 0;
    this.currentCollector = null;
    this.runtime?.destroy();
    this.runtime = null;
    this.runtimePromise = null;
  }

  private restartRuntime(): void {
    this.runtime?.destroy();
    this.runtime = null;
    this.runtimePromise = null;
    if (this.disposed) {
      return;
    }

    void this.ensureRuntime().catch(() => undefined);
  }

  private async ensureRuntime(): Promise<SileroVadRuntime> {
    if (this.disposed) {
      throw new Error("VAD already disposed");
    }

    if (this.runtime) {
      return this.runtime;
    }

    if (!this.runtimePromise) {
      this.runtimePromise = this.createRuntime(this.callbacks, this.config)
        .then((runtime) => {
          runtime.start();
          this.runtime = runtime;
          return runtime;
        })
        .catch((error) => {
          this.runtimePromise = null;
          throw error;
        });
    }

    return this.runtimePromise;
  }
}

export async function createSileroVadProcessor(
  config: VoiceActivityDetectorConfig,
  options?: CreateSileroVadProcessorOptions
): Promise<VoiceActivityDetector> {
  return SileroVadProcessor.create(config, options);
}

export async function createVoiceActivityDetector(
  input: CreateVoiceActivityDetectorInput
): Promise<VoiceActivityDetector> {
  try {
    return await createSileroVadProcessor(
      input.config,
      input.createRuntime ? { createRuntime: input.createRuntime } : undefined
    );
  } catch (v5Error) {
    input.logger.warn(
      "realtime-voice-vad",
      "silero-v5-init-failed",
      undefined,
      v5Error
    );
    throw v5Error;
  }
}
