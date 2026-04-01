import { randomUUID } from "node:crypto";
import type {
  AppConfig,
  ChatAttachment,
  RealtimeVoiceMode,
  VoiceSessionEvent,
  VoiceSessionState,
  VoiceSessionTarget
} from "@shared/types";
import type { RuntimeInboundChannel } from "@main/storage/runtime-context-store";
import type { AppLogger } from "./logger";
import type { CompanionPaths } from "@main/storage/paths";
import type { YobiMemory } from "@main/memory/setup";
import type { ConversationEngine } from "@main/core/conversation";
import { isAbortLikeError } from "@main/core/conversation-abort";
import type { PetVoiceEvent } from "@shared/pet-events";
import type { CompanionSpeechCaptureSession } from "./companion-mode";
import { SentenceChunkBuffer } from "./realtime-voice-chunker";
import { shouldAutoStartVoiceSession } from "./realtime-voice-lifecycle";
import { PlaybackReferenceTracker } from "./realtime-voice-playback-reference";
import { buildInterruptedAssistantCommit } from "./realtime-voice-persistence";
import { createVoiceSessionState, reduceVoiceSessionState } from "./realtime-voice-state";
import {
  createVoiceActivityDetector,
  getVoiceActivityDetectorConfig,
  type VoiceActivityDetector,
  type VoiceActivityDetectorConfig
} from "./realtime-voice-vad";
import { VoiceProviderRouter, type StreamingAsrSession, type StreamingTtsSession } from "./voice-router";
import type { NativeAudioCaptureBackend } from "./native-audio-capture";

interface RealtimeVoicePlaybackBridge {
  enqueueSpeech(input: {
    chunkId: string;
    audioBase64: string;
    text: string;
    mimeType: string;
    generation: number;
  }): Promise<boolean> | boolean;
  clearSpeech(input: { generation: number; reason?: string }): Promise<boolean> | boolean;
  onVoiceEvent?(listener: (event: PetVoiceEvent) => void): () => void;
}

interface RealtimeVoiceServiceInput {
  paths: CompanionPaths;
  logger: AppLogger;
  getConfig: () => AppConfig;
  voiceRouter: VoiceProviderRouter;
  conversation: ConversationEngine;
  memory: YobiMemory;
  defaultTarget: {
    resourceId: string;
    threadId: string;
  };
  onRecordUserActivity?: (input: {
    channel: RuntimeInboundChannel;
    chatId?: string;
    text?: string;
  }) => Promise<void>;
  onAssistantMessage?: () => Promise<void>;
  onStatusChange?: () => void | Promise<void>;
  captureCompanionSpeechStartContext?: () => Promise<CompanionSpeechCaptureSession | null>;
  captureCompanionSpeechRecapture?: (session: CompanionSpeechCaptureSession | null) => Promise<void>;
  createVad?: (input: {
    config: VoiceActivityDetectorConfig;
    logger: AppLogger;
  }) => Promise<VoiceActivityDetector>;
  captureService?: NativeAudioCaptureBackend;
  playbackBridge?: RealtimeVoicePlaybackBridge | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toLogPreview(text: string, maxChars = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars)}...`;
}

function createEmptyVoiceState(mode: RealtimeVoiceMode): VoiceSessionState {
  return {
    sessionId: null,
    phase: "idle",
    mode,
    target: null,
    userTranscript: "",
    userTranscriptMetadata: null,
    assistantTranscript: "",
    lastInterruptReason: null,
    errorMessage: null,
    playback: {
      active: false,
      queueLength: 0,
      level: 0,
      currentText: ""
    },
    updatedAt: nowIso()
  };
}

const TRANSCRIPTION_TIMEOUT_ERROR = "realtime-voice-transcription-timeout";
const ASSISTANT_PROGRESS_TIMEOUT_ERROR = "realtime-voice-assistant-progress-timeout";
const PLAYBACK_START_TIMEOUT_ERROR = "realtime-voice-playback-start-timeout";
const SILENCE_RMS_THRESHOLD = 0.008;

function createPlaybackState(): VoiceSessionState["playback"] {
  return {
    active: false,
    queueLength: 0,
    level: 0,
    currentText: ""
  };
}

function createTimeoutError(message: string): Error {
  const error = new Error(message);
  error.name = "RealtimeVoiceTimeoutError";
  return error;
}

function isTimeoutError(error: unknown, message: string): boolean {
  return error instanceof Error && error.message === message;
}

function getPcm16RmsLevel(chunk: Buffer): number {
  const sampleCount = Math.floor(chunk.length / 2);
  if (sampleCount <= 0) {
    return 0;
  }

  let squareSum = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const normalized = chunk.readInt16LE(index * 2) / 0x8000;
    squareSum += normalized * normalized;
  }

  return Math.sqrt(squareSum / sampleCount);
}

export class RealtimeVoiceService {
  private readonly captureService: NativeAudioCaptureBackend | null;
  private readonly playbackBridge: RealtimeVoicePlaybackBridge | null;
  private readonly listeners = new Set<(event: VoiceSessionEvent) => void>();
  private readonly disposePlaybackListener: (() => void) | null;
  private assistantReplyHook:
    | ((input: {
        channel: RuntimeInboundChannel;
        userText: string;
        assistantText: string;
      }) => Promise<void> | void)
    | null = null;
  private captureCompanionSpeechStartContext:
    (() => Promise<CompanionSpeechCaptureSession | null>) | null = null;
  private captureCompanionSpeechRecapture:
    ((session: CompanionSpeechCaptureSession | null) => Promise<void>) | null = null;
  private state: VoiceSessionState;
  private pttHeld = false;
  private vad: VoiceActivityDetector | null = null;
  private vadPromise: Promise<VoiceActivityDetector> | null = null;
  private vadConfig: VoiceActivityDetectorConfig | null = null;
  private speechActive = false;
  private speechStartedAtMs = 0;
  private speechGeneration = 0;
  private speechSilenceStartedAtMs = 0;
  private preRollBuffers: Buffer[] = [];
  private speechBuffers: Buffer[] = [];
  private activeSpeechCaptureSession: CompanionSpeechCaptureSession | null = null;
  private activeSpeechCapturePromise: Promise<CompanionSpeechCaptureSession | null> | null = null;
  private speechCaptureGeneration = 0;
  private activeAsrSession: StreamingAsrSession | null = null;
  private activeTtsSession: StreamingTtsSession | null = null;
  private replyAbortController: AbortController | null = null;
  private assistantGeneration = 0;
  private assistantProgressTimer: ReturnType<typeof setTimeout> | null = null;
  private assistantProgressReject: ((error: Error) => void) | null = null;
  private assistantProgressGeneration = 0;
  private responseSequence = Promise.resolve();
  private ttsSequence = Promise.resolve();
  private pendingSynthesisCount = 0;
  private pendingPlaybackTexts = new Map<string, string>();
  private playbackStartTimer: ReturnType<typeof setTimeout> | null = null;
  private playbackStartChunkId: string | null = null;
  private playbackStartGeneration = 0;
  private playbackGeneration = 0;
  private playedChunkIds = new Set<string>();
  private llmFinished = false;
  private llmVisibleText = "";
  private playedAssistantText = "";
  private assistantCommitPersisted = false;
  private readonly playbackReferenceTracker = new PlaybackReferenceTracker();

  constructor(private readonly input: RealtimeVoiceServiceInput) {
    this.captureService = input.captureService ?? null;
    this.playbackBridge = input.playbackBridge ?? null;
    this.captureCompanionSpeechStartContext = input.captureCompanionSpeechStartContext ?? null;
    this.captureCompanionSpeechRecapture = input.captureCompanionSpeechRecapture ?? null;
    this.state = createEmptyVoiceState(this.input.getConfig().realtimeVoice.mode);
    this.disposePlaybackListener = this.playbackBridge?.onVoiceEvent?.((message) => {
      void this.handlePlaybackEvent(message).catch((error) => {
        this.fail(error instanceof Error ? error.message : "实时语音处理失败");
      });
    }) ?? null;
    this.captureService?.onPcmFrame((frame) => {
      void this.handlePcmFrame(frame.pcm, frame.sampleRate).catch((error) => {
        this.fail(error instanceof Error ? error.message : "实时语音处理失败");
      });
    });
  }

  start(): void {
    const config = this.input.getConfig();
    this.state = createEmptyVoiceState(config.realtimeVoice.mode);
    void this.captureService?.warmup?.().catch((error) => {
      this.input.logger.warn("realtime-voice", "native-capture-warmup-failed", undefined, error);
    });
    void this.ensureVadReady().catch((error) => {
      this.input.logger.warn("realtime-voice", "vad-warmup-failed", undefined, error);
    });
    if (
      shouldAutoStartVoiceSession({
        enabled: config.realtimeVoice.enabled,
        mode: config.realtimeVoice.mode
      })
    ) {
      void this.startSession({
        mode: config.realtimeVoice.mode
      });
    }
  }

  stop(): void {
    void this.stopSession();
    this.disposePlaybackListener?.();
    this.disposeVad();
    void this.captureService?.stop().catch(() => undefined);
  }

  setAssistantReplyHook(
    hook: (input: {
      channel: RuntimeInboundChannel;
      userText: string;
      assistantText: string;
    }) => Promise<void> | void
  ): void {
    this.assistantReplyHook = hook;
  }

  setCompanionCaptureHooks(input: {
    captureCompanionSpeechStartContext?: (() => Promise<CompanionSpeechCaptureSession | null>) | null;
    captureCompanionSpeechRecapture?: ((session: CompanionSpeechCaptureSession | null) => Promise<void>) | null;
  }): void {
    this.captureCompanionSpeechStartContext = input.captureCompanionSpeechStartContext ?? null;
    this.captureCompanionSpeechRecapture = input.captureCompanionSpeechRecapture ?? null;
  }

  isActive(): boolean {
    return this.state.sessionId !== null;
  }

  getState(): VoiceSessionState {
    return {
      ...this.state,
      playback: {
        ...this.state.playback
      },
      target: this.state.target ? { ...this.state.target } : null
    };
  }

  onEvent(listener: (event: VoiceSessionEvent) => void): () => void {
    this.listeners.add(listener);
    listener({
      type: "state",
      state: this.getState(),
      timestamp: nowIso()
    });
    return () => {
      this.listeners.delete(listener);
    };
  }

  async startSession(input?: {
    mode?: RealtimeVoiceMode;
    target?: Partial<VoiceSessionTarget>;
  }): Promise<VoiceSessionState> {
    const config = this.input.getConfig();
    const mode = input?.mode ?? this.state.mode ?? config.realtimeVoice.mode;
    const sessionId = this.state.sessionId ?? randomUUID();
    const target: VoiceSessionTarget = {
      resourceId: input?.target?.resourceId ?? this.input.defaultTarget.resourceId,
      threadId: input?.target?.threadId ?? this.input.defaultTarget.threadId,
      source: input?.target?.source ?? "voice"
    };

    this.state = createVoiceSessionState({
      sessionId,
      mode,
      target
    });
    this.input.logger.info("realtime-voice", "session:start", {
      mode,
      target
    });
    this.resetSpeechTracking();

    if (mode === "free") {
      await this.ensureVadReady();
      await this.captureService?.startStream();
    }

    this.applyState({
      type: "session-started"
    });
    await this.notifyStatusChange();
    return this.getState();
  }

  async stopSession(): Promise<{ accepted: boolean }> {
    if (!this.state.sessionId) {
      return {
        accepted: false
      };
    }

    await this.abortActiveResponse("system");
    await this.captureService?.stopStream().catch(() => undefined);
    await this.clearPlayback("system");
    this.pttHeld = false;
    this.resetSpeechTracking();
    this.state = createEmptyVoiceState(this.state.mode);
    this.emitState();
    await this.notifyStatusChange();
    return {
      accepted: true
    };
  }

  async interrupt(reason: "vad" | "manual" | "system" = "manual"): Promise<{ accepted: boolean }> {
    if (!this.state.sessionId) {
      return {
        accepted: false
      };
    }

    await this.abortActiveResponse(reason);
    await this.clearPlayback(reason);
    this.applyState({
      type: "barge-in-detected",
      reason
    });
    this.resetSpeechTracking();
    return {
      accepted: true
    };
  }

  async setMode(mode: RealtimeVoiceMode): Promise<VoiceSessionState> {
    this.state = {
      ...this.state,
      mode,
      updatedAt: nowIso()
    };
    this.emitState();

    if (!this.state.sessionId) {
      return this.getState();
    }

    if (mode === "free") {
      await this.captureService?.startStream();
    } else if (!this.pttHeld) {
      await this.captureService?.stopStream().catch(() => undefined);
    }

    return this.getState();
  }

  async handlePttPhase(phase: "down" | "up"): Promise<void> {
    if (this.state.mode !== "ptt") {
      return;
    }

    if (!this.state.sessionId) {
      await this.startSession({
        mode: "ptt"
      });
    }

    if (phase === "down") {
      if (this.pttHeld) {
        return;
      }

      this.pttHeld = true;
      this.resetSpeechTracking();
      await this.beginSpeech();
      await this.captureService?.startStream();
      return;
    }

    if (!this.pttHeld) {
      return;
    }

    this.pttHeld = false;
    await this.captureService?.stopStream().catch(() => undefined);
    await this.finishSpeech();
  }

  async speakText(text: string): Promise<void> {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }

    const config = this.input.getConfig();
    const session = this.input.voiceRouter.createStreamingTtsSession({
      edgeConfig: {
        voice: config.voice.ttsVoice,
        rate: config.voice.ttsRate,
        pitch: config.voice.ttsPitch,
        requestTimeoutMs: config.voice.requestTimeoutMs,
        retryCount: config.voice.retryCount
      }
    });
    const audio = await session.synthesizeChunk(normalized);
    await this.enqueuePlayback({
      id: `standalone-${randomUUID()}`,
      audioBase64: audio.toString("base64"),
      text: normalized,
      mimeType: "audio/mpeg",
      generation: this.state.sessionId ? this.playbackGeneration : 0
    });
    await session.close();
  }

  private emit(event: VoiceSessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.input.logger.warn("realtime-voice", "listener-failed", undefined, error);
      }
    }
  }

  private emitState(): void {
    this.emit({
      type: "state",
      state: this.getState(),
      timestamp: nowIso()
    });
  }

  private async ensureVadReady(): Promise<VoiceActivityDetector> {
    const config = getVoiceActivityDetectorConfig(this.input.getConfig().realtimeVoice);
    if (this.vad && this.vadConfig && this.isSameVadConfig(this.vadConfig, config)) {
      return this.vad;
    }

    if (this.vadPromise && this.vadConfig && this.isSameVadConfig(this.vadConfig, config)) {
      return this.vadPromise;
    }

    this.disposeVad();
    this.vadConfig = config;
    const createVad = this.input.createVad ?? createVoiceActivityDetector;

    this.vadPromise = createVad({
      config,
      logger: this.input.logger
    })
      .then((vad) => {
        this.vad = vad;
        return vad;
      })
      .catch((error) => {
        this.vadPromise = null;
        this.vadConfig = null;
        throw error;
      });

    return this.vadPromise;
  }

  private disposeVad(): void {
    this.vad?.dispose();
    this.vad = null;
    this.vadPromise = null;
    this.vadConfig = null;
  }

  private isSameVadConfig(
    left: VoiceActivityDetectorConfig,
    right: VoiceActivityDetectorConfig
  ): boolean {
    return (
      left.vadThreshold === right.vadThreshold &&
      left.minSpeechMs === right.minSpeechMs &&
      left.minSilenceMs === right.minSilenceMs
    );
  }

  private resetSpeechTracking(): void {
    this.speechActive = false;
    this.speechStartedAtMs = 0;
    this.invalidateSpeechGeneration();
    this.preRollBuffers = [];
    this.speechBuffers = [];
    this.speechSilenceStartedAtMs = 0;
    this.playbackReferenceTracker.clear();
    this.speechCaptureGeneration += 1;
    this.activeSpeechCaptureSession = null;
    this.activeSpeechCapturePromise = null;
    this.vad?.reset();
    if (this.activeAsrSession) {
      void this.activeAsrSession.abort().catch(() => undefined);
      this.activeAsrSession = null;
    }
  }

  private rememberPreRoll(chunk: Buffer): void {
    const preRollMs = Math.max(0, this.input.getConfig().realtimeVoice.preRollMs);
    const maxBytes = Math.max(0, Math.round(preRollMs * 32));
    if (maxBytes === 0) {
      this.preRollBuffers = [];
      return;
    }

    this.preRollBuffers.push(Buffer.from(chunk));
    let total = this.preRollBuffers.reduce((sum, item) => sum + item.length, 0);
    while (total > maxBytes && this.preRollBuffers.length > 0) {
      const removed = this.preRollBuffers.shift();
      total -= removed?.length ?? 0;
    }
  }

  private clearCurrentTurnTranscripts(): void {
    this.state = {
      ...this.state,
      userTranscript: "",
      userTranscriptMetadata: null,
      assistantTranscript: "",
      updatedAt: nowIso()
    };
  }

  private getRequestTimeoutMs(): number {
    return Math.max(20, this.input.getConfig().voice.requestTimeoutMs);
  }

  private getAssistantProgressTimeoutMs(): number {
    return Math.max(40, this.getRequestTimeoutMs() * 2);
  }

  private getPlaybackStartTimeoutMs(): number {
    return Math.max(60, Math.min(2_500, Math.round(this.getRequestTimeoutMs() / 2)));
  }

  private getForcedSpeechSilenceMs(): number {
    return Math.max(1_200, this.input.getConfig().realtimeVoice.minSilenceMs + 600);
  }

  private invalidateSpeechGeneration(): number {
    this.speechGeneration += 1;
    this.speechSilenceStartedAtMs = 0;
    return this.speechGeneration;
  }

  private invalidateAssistantGeneration(): number {
    this.assistantGeneration += 1;
    return this.assistantGeneration;
  }

  private isSpeechGenerationCurrent(generation: number): boolean {
    return this.state.sessionId !== null && this.speechGeneration === generation;
  }

  private isAssistantGenerationCurrent(generation: number): boolean {
    return this.state.sessionId !== null && this.assistantGeneration === generation;
  }

  private transitionToReadyState(): void {
    this.state = {
      ...this.state,
      phase: this.state.sessionId && this.state.mode === "free" ? "listening" : "idle",
      errorMessage: null,
      playback: createPlaybackState(),
      updatedAt: nowIso()
    };
    this.emitState();
  }

  private clearSpeechBuffers(): void {
    this.activeSpeechCaptureSession = null;
    this.activeSpeechCapturePromise = null;
    this.preRollBuffers = [];
    this.speechBuffers = [];
    this.speechSilenceStartedAtMs = 0;
    this.vad?.reset();
  }

  private async withTimeout<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(createTimeoutError(message));
      }, timeoutMs);
      timer.unref?.();

      task.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  private startAssistantProgressWatchdog(generation: number): Promise<never> {
    this.clearAssistantProgressWatchdog();
    this.assistantProgressGeneration = generation;

    return new Promise<never>((_resolve, reject) => {
      this.assistantProgressReject = reject;
      this.refreshAssistantProgressWatchdog(generation);
    });
  }

  private refreshAssistantProgressWatchdog(generation: number): void {
    if (!this.isAssistantGenerationCurrent(generation) || !this.assistantProgressReject) {
      return;
    }

    if (this.assistantProgressTimer) {
      clearTimeout(this.assistantProgressTimer);
      this.assistantProgressTimer = null;
    }

    this.assistantProgressGeneration = generation;
    this.assistantProgressTimer = setTimeout(() => {
      if (this.assistantProgressGeneration !== generation) {
        return;
      }

      this.assistantProgressTimer = null;
      this.assistantProgressReject?.(createTimeoutError(ASSISTANT_PROGRESS_TIMEOUT_ERROR));
    }, this.getAssistantProgressTimeoutMs());
    this.assistantProgressTimer.unref?.();
  }

  private clearAssistantProgressWatchdog(): void {
    if (this.assistantProgressTimer) {
      clearTimeout(this.assistantProgressTimer);
      this.assistantProgressTimer = null;
    }

    this.assistantProgressReject = null;
    this.assistantProgressGeneration = 0;
  }

  private clearPlaybackStartWatchdog(): void {
    if (this.playbackStartTimer) {
      clearTimeout(this.playbackStartTimer);
      this.playbackStartTimer = null;
    }

    this.playbackStartChunkId = null;
    this.playbackStartGeneration = 0;
  }

  private armPlaybackStartWatchdog(chunkId: string, generation: number): void {
    if (
      !chunkId ||
      !this.isPlaybackGenerationCurrent(generation) ||
      this.state.playback.active
    ) {
      return;
    }

    if (this.playbackStartChunkId === chunkId && this.playbackStartGeneration === generation) {
      return;
    }

    this.clearPlaybackStartWatchdog();
    this.playbackStartChunkId = chunkId;
    this.playbackStartGeneration = generation;
    this.playbackStartTimer = setTimeout(() => {
      if (
        this.playbackStartChunkId !== chunkId ||
        this.playbackStartGeneration !== generation
      ) {
        return;
      }

      this.playbackStartTimer = null;
      void this.recoverFromPlaybackStartTimeout(chunkId, generation);
    }, this.getPlaybackStartTimeoutMs());
    this.playbackStartTimer.unref?.();
  }

  private syncPlaybackStartWatchdog(generation = this.playbackGeneration): void {
    if (this.state.playback.active) {
      this.clearPlaybackStartWatchdog();
      return;
    }

    const nextChunkId = this.pendingPlaybackTexts.keys().next().value;
    if (typeof nextChunkId !== "string" || !nextChunkId) {
      this.clearPlaybackStartWatchdog();
      return;
    }

    this.armPlaybackStartWatchdog(nextChunkId, generation);
  }

  private async recoverFromAssistantTimeout(): Promise<void> {
    this.input.logger.warn("realtime-voice", "assistant:progress-timeout", {
      sessionId: this.state.sessionId ?? "unknown",
      phase: this.state.phase
    }, createTimeoutError(ASSISTANT_PROGRESS_TIMEOUT_ERROR));
    await this.abortActiveResponse("system");
    await this.clearPlayback("system");
    this.playbackReferenceTracker.clear();
    this.clearCurrentTurnTranscripts();
    this.transitionToReadyState();
    await this.notifyStatusChange();
  }

  private async recoverFromPlaybackStartTimeout(
    chunkId: string,
    generation: number
  ): Promise<void> {
    if (
      !this.isPlaybackGenerationCurrent(generation) ||
      !this.pendingPlaybackTexts.has(chunkId)
    ) {
      return;
    }

    this.input.logger.warn("realtime-voice", "assistant:playback-start-timeout", {
      sessionId: this.state.sessionId ?? "unknown",
      phase: this.state.phase,
      chunkId,
      generation,
      pendingPlaybackCount: this.pendingPlaybackTexts.size
    }, createTimeoutError(PLAYBACK_START_TIMEOUT_ERROR));
    await this.abortActiveResponse("system");
    await this.clearPlayback("system");
    this.playbackReferenceTracker.clear();
    this.clearCurrentTurnTranscripts();
    this.transitionToReadyState();
    await this.notifyStatusChange();
  }

  private async recoverFromTranscriptionTimeout(asrSession: StreamingAsrSession): Promise<void> {
    this.input.logger.warn("realtime-voice", "speech:transcription-timeout", {
      sessionId: this.state.sessionId ?? "unknown"
    }, createTimeoutError(TRANSCRIPTION_TIMEOUT_ERROR));
    await asrSession.abort().catch(() => undefined);
    this.clearCurrentTurnTranscripts();
    this.transitionToReadyState();
    await this.notifyStatusChange();
  }

  private shouldForceSpeechFinish(input: {
    chunk: Buffer;
    probability: number;
    nowMs: number;
  }): boolean {
    if (!this.speechActive) {
      this.speechSilenceStartedAtMs = 0;
      return false;
    }

    const activityProbabilityFloor = Math.min(
      0.18,
      Math.max(0.08, this.input.getConfig().realtimeVoice.vadThreshold * 0.6)
    );
    const speechLikely =
      input.probability >= activityProbabilityFloor || getPcm16RmsLevel(input.chunk) >= SILENCE_RMS_THRESHOLD;

    if (speechLikely) {
      this.speechSilenceStartedAtMs = 0;
      return false;
    }

    if (this.speechSilenceStartedAtMs === 0) {
      this.speechSilenceStartedAtMs = input.nowMs;
      return false;
    }

    return input.nowMs - this.speechSilenceStartedAtMs >= this.getForcedSpeechSilenceMs();
  }

  private shouldInterruptAssistantForSpeechStart(): boolean {
    if (!this.input.getConfig().realtimeVoice.autoInterrupt) {
      return false;
    }

    return this.state.phase === "assistant-thinking" || this.state.phase === "assistant-speaking";
  }

  private async beginSpeech(): Promise<void> {
    if (this.speechActive) {
      return;
    }

    if (this.shouldInterruptAssistantForSpeechStart()) {
      await this.interrupt("vad");
    }

    const speechGeneration = this.invalidateSpeechGeneration();
    this.speechActive = true;
    this.speechStartedAtMs = Date.now();
    this.speechBuffers = [];
    this.speechSilenceStartedAtMs = 0;
    this.startSpeechCaptureContext();
    this.input.logger.info("realtime-voice", "speech:start", {
      sessionId: this.state.sessionId ?? "unknown"
    });
    this.clearCurrentTurnTranscripts();
    this.applyState({
      type: "speech-started"
    });
    this.activeAsrSession = this.input.voiceRouter.createStreamingAsrSession({
      sampleRate: 16_000,
      onPartial: (text) => {
        if (!this.isSpeechGenerationCurrent(speechGeneration)) {
          return;
        }

        this.state = {
          ...this.state,
          userTranscript: text,
          userTranscriptMetadata: null,
          updatedAt: nowIso()
        };
        this.emit({
          type: "user-transcript",
          text,
          isFinal: false,
          metadata: null,
          timestamp: nowIso()
        });
        this.emitState();
      }
    });

    for (const chunk of this.preRollBuffers) {
      this.speechBuffers.push(Buffer.from(chunk));
      void this.activeAsrSession.pushPcm(chunk).catch((error) => {
        this.input.logger.warn("realtime-voice", "push-preroll-failed", undefined, error);
      });
    }
  }

  private async finishSpeech(): Promise<void> {
    if (!this.speechActive) {
      return;
    }

    const speechGeneration = this.speechGeneration;
    this.speechActive = false;
    this.speechSilenceStartedAtMs = 0;
    this.input.logger.info("realtime-voice", "speech:finish", {
      sessionId: this.state.sessionId ?? "unknown",
      bufferedBytes: this.speechBuffers.reduce((sum, item) => sum + item.length, 0)
    });
    this.applyState({
      type: "speech-ended"
    });

    const asrSession = this.activeAsrSession;
    this.activeAsrSession = null;
    if (!asrSession) {
      if (this.state.mode === "free") {
        this.applyState({
          type: "session-started"
        });
      }
      return;
    }

    try {
      const recognized = await this.withTimeout(
        asrSession.flush(),
        this.getRequestTimeoutMs(),
        TRANSCRIPTION_TIMEOUT_ERROR
      );
      if (!this.isSpeechGenerationCurrent(speechGeneration)) {
        return;
      }

      const text = recognized.text.trim();
      let speechCaptureSession: CompanionSpeechCaptureSession | null = null;
      try {
        speechCaptureSession = await this.withTimeout(
          this.awaitSpeechCaptureSession(),
          this.getRequestTimeoutMs(),
          TRANSCRIPTION_TIMEOUT_ERROR
        );
      } catch (error) {
        if (!isTimeoutError(error, TRANSCRIPTION_TIMEOUT_ERROR)) {
          throw error;
        }

        this.input.logger.warn(
          "realtime-voice",
          "capture-speech-context-timeout",
          {
            sessionId: this.state.sessionId ?? "unknown"
          },
          error
        );
      }

      if (!this.isSpeechGenerationCurrent(speechGeneration)) {
        return;
      }

      const speechAttachments = speechCaptureSession?.attachments ?? [];
      if (!text) {
        this.state = {
          ...this.state,
          userTranscript: "",
          userTranscriptMetadata: null,
          updatedAt: nowIso()
        };
        if (this.state.mode === "free") {
          this.applyState({
            type: "session-started"
          });
        }
        return;
      }

      this.state = {
        ...this.state,
        userTranscript: text,
        userTranscriptMetadata: recognized.metadata,
        updatedAt: nowIso()
      };
      this.input.logger.info("realtime-voice", "speech:transcribed", {
        sessionId: this.state.sessionId ?? "unknown",
        textLength: text.length,
        textPreview: toLogPreview(text)
      });
      this.emit({
        type: "user-transcript",
        text,
        isFinal: true,
        metadata: recognized.metadata,
        ...(speechAttachments.length > 0
          ? {
              attachments: speechAttachments
            }
          : {}),
        timestamp: nowIso()
      });
      this.emitState();
      await this.handleUserTurn(text, recognized.metadata, speechAttachments);
    } catch (error) {
      if (!this.isSpeechGenerationCurrent(speechGeneration)) {
        return;
      }

      if (isTimeoutError(error, TRANSCRIPTION_TIMEOUT_ERROR)) {
        this.clearSpeechBuffers();
        this.invalidateSpeechGeneration();
        await this.recoverFromTranscriptionTimeout(asrSession);
        return;
      }

      this.fail(error instanceof Error ? error.message : "语音识别失败");
    } finally {
      if (this.speechGeneration === speechGeneration) {
        this.activeSpeechCaptureSession = null;
        this.activeSpeechCapturePromise = null;
        this.preRollBuffers = [];
        this.speechBuffers = [];
        this.speechSilenceStartedAtMs = 0;
        this.vad?.reset();
      }
    }
  }

  private startSpeechCaptureContext(): void {
    const generation = ++this.speechCaptureGeneration;
    const capturePromise = (async () => {
      try {
        return await this.captureCompanionSpeechStartContext?.() ?? null;
      } catch (error) {
        this.input.logger.warn(
          "realtime-voice",
          "capture-speech-start-context-failed",
          undefined,
          error
        );
        return null;
      }
    })();

    this.activeSpeechCapturePromise = capturePromise;
    void capturePromise.then((session) => {
      if (this.speechCaptureGeneration !== generation) {
        return;
      }

      this.activeSpeechCaptureSession = session;
    });
  }

  private async awaitSpeechCaptureSession(): Promise<CompanionSpeechCaptureSession | null> {
    const pendingCapture = this.activeSpeechCapturePromise;
    if (!pendingCapture) {
      return this.activeSpeechCaptureSession;
    }

    try {
      const session = await pendingCapture;
      return session ?? this.activeSpeechCaptureSession;
    } finally {
      if (this.activeSpeechCapturePromise === pendingCapture) {
        this.activeSpeechCapturePromise = null;
      }
    }
  }

  private async handlePlaybackEvent(message: PetVoiceEvent): Promise<void> {
    if (message.type === "speech-reference-frame") {
      if (!this.isPlaybackGenerationCurrent(message.generation)) {
        return;
      }
      this.refreshAssistantProgressWatchdog(this.assistantGeneration);
      this.playbackReferenceTracker.pushFrame({
        pcm: Buffer.from(message.pcm),
        sampleRate: message.sampleRate
      });
      return;
    }

    if (message.type === "speech-playback-started") {
      if (!this.isPlaybackGenerationCurrent(message.generation)) {
        return;
      }
      if (this.playbackStartChunkId === message.chunkId) {
        this.clearPlaybackStartWatchdog();
      }
      this.refreshAssistantProgressWatchdog(this.assistantGeneration);
      this.pendingPlaybackTexts.set(message.chunkId, message.text);
      if (!this.playedChunkIds.has(message.chunkId)) {
        this.playedChunkIds.add(message.chunkId);
        this.playedAssistantText += message.text;
      }
      this.applyState({
        type: "assistant-playback-started"
      });
      this.state = {
        ...this.state,
        playback: {
          active: true,
          queueLength: message.queueLength,
          level: this.state.playback.level,
          currentText: message.text
        },
        updatedAt: nowIso()
      };
      this.emit({
        type: "playback",
        playback: {
          ...this.state.playback
        },
        timestamp: nowIso()
      });
      this.emitState();
      return;
    }

    if (message.type === "speech-playback-ended") {
      if (!this.isPlaybackGenerationCurrent(message.generation)) {
        return;
      }
      if (this.playbackStartChunkId === message.chunkId) {
        this.clearPlaybackStartWatchdog();
      }
      this.refreshAssistantProgressWatchdog(this.assistantGeneration);
      this.pendingPlaybackTexts.delete(message.chunkId);
      this.state = {
        ...this.state,
        playback: {
          active: message.queueLength > 0,
          queueLength: message.queueLength,
          level: 0,
          currentText: ""
        },
        updatedAt: nowIso()
      };
      this.emit({
        type: "playback",
        playback: {
          ...this.state.playback
        },
        timestamp: nowIso()
      });
      this.emitState();
      this.syncPlaybackStartWatchdog(message.generation);
      await this.maybeFinalizeAssistantTurn();
      return;
    }

    if (message.type === "speech-playback-cleared") {
      if (!this.isPlaybackGenerationCurrent(message.generation)) {
        return;
      }
      this.clearPlaybackStartWatchdog();
      this.refreshAssistantProgressWatchdog(this.assistantGeneration);
      this.pendingPlaybackTexts.clear();
      this.playbackReferenceTracker.clear();
      this.state = {
        ...this.state,
        playback: {
          active: false,
          queueLength: 0,
          level: 0,
          currentText: ""
        },
        updatedAt: nowIso()
      };
      this.emit({
        type: "playback",
        playback: {
          ...this.state.playback
        },
        timestamp: nowIso()
      });
      this.emitState();
      return;
    }

    if (message.type === "speech-playback-error") {
      if (!this.isPlaybackGenerationCurrent(message.generation)) {
        return;
      }
      if (this.playbackStartChunkId === message.chunkId) {
        this.clearPlaybackStartWatchdog();
      }
      this.refreshAssistantProgressWatchdog(this.assistantGeneration);
      this.pendingPlaybackTexts.delete(message.chunkId);
      const queueLength = this.pendingPlaybackTexts.size;
      this.state = {
        ...this.state,
        playback: {
          active: queueLength > 0,
          queueLength,
          level: 0,
          currentText: ""
        },
        updatedAt: nowIso()
      };
      this.emitState();
      this.syncPlaybackStartWatchdog(message.generation);
      await this.maybeFinalizeAssistantTurn();
    }
  }

  private async handlePcmFrame(chunk: Buffer, sampleRate: number): Promise<void> {
    if (sampleRate !== 16_000 || chunk.length === 0) {
      return;
    }

    if (this.state.mode === "ptt") {
      if (!this.pttHeld || !this.activeAsrSession) {
        return;
      }

      this.speechBuffers.push(Buffer.from(chunk));
      await this.activeAsrSession.pushPcm(chunk);
      await this.captureCompanionSpeechRecapture?.(this.activeSpeechCaptureSession ?? null);
      return;
    }

    // During assistant playback, reject mic chunks that still look like the rendered TTS
    // instead of globally muting barge-in while audio is active.
    if (
      !this.speechActive &&
      this.playbackReferenceTracker.classifyMicChunk({
        pcm: chunk,
        sampleRate,
        capturedAtMs: Date.now()
      }).echoLikely
    ) {
      this.preRollBuffers = [];
      this.vad?.reset();
      return;
    }

    const wasSpeechActive = this.speechActive;
    const vad = await this.ensureVadReady();
    const result = await vad.processChunk(chunk);
    const nowMs = Date.now();

    if (!wasSpeechActive && !result.speechStarted) {
      this.rememberPreRoll(chunk);
    }

    if (result.speechStarted) {
      await this.beginSpeech();
    }

    if (this.speechActive && this.activeAsrSession) {
      this.speechBuffers.push(Buffer.from(chunk));
      await this.activeAsrSession.pushPcm(chunk);
      await this.captureCompanionSpeechRecapture?.(this.activeSpeechCaptureSession ?? null);
    }

    const config = this.input.getConfig().realtimeVoice;
    if (this.speechActive && nowMs - this.speechStartedAtMs >= config.maxUtteranceMs) {
      await this.finishSpeech();
      return;
    }

    if (this.speechActive && this.shouldForceSpeechFinish({
      chunk,
      probability: result.probability,
      nowMs
    })) {
      await this.finishSpeech();
      return;
    }

    if (this.speechActive && result.speechEnded) {
      await this.finishSpeech();
    }
  }

  private async handleUserTurn(
    text: string,
    metadata: VoiceSessionState["userTranscriptMetadata"] = null,
    attachments: ChatAttachment[] = []
  ): Promise<void> {
    const sessionId = this.state.sessionId;
    const target = this.state.target;
    if (!sessionId || !target) {
      return;
    }

    const config = this.input.getConfig();
    this.input.logger.info("realtime-voice", "llm:user-input", {
      sessionId,
      textLength: text.length,
      textPreview: toLogPreview(text)
    });
    await this.input.onRecordUserActivity?.({
      channel: "console",
      text
    });

    const assistantGeneration = this.invalidateAssistantGeneration();
    const replyAbortController = new AbortController();
    this.replyAbortController = replyAbortController;
    this.llmFinished = false;
    this.llmVisibleText = "";
    this.playedAssistantText = "";
    this.assistantCommitPersisted = false;
    this.ttsSequence = Promise.resolve();
    this.pendingPlaybackTexts.clear();
    this.clearPlaybackStartWatchdog();
    this.playedChunkIds.clear();
    const playbackGeneration = this.beginPlaybackGeneration();
    const assistantProgressWatchdog = this.startAssistantProgressWatchdog(assistantGeneration);

    const chunker = new SentenceChunkBuffer({
      firstChunkMinChars: config.realtimeVoice.firstChunkStrategy === "aggressive" ? 6 : 12,
      subsequentChunkMinChars: 18
    });
    const ttsSession = this.input.voiceRouter.createStreamingTtsSession({
      edgeConfig: {
        voice: config.voice.ttsVoice,
        rate: config.voice.ttsRate,
        pitch: config.voice.ttsPitch,
        requestTimeoutMs: config.voice.requestTimeoutMs,
        retryCount: config.voice.retryCount
      }
    });
    this.activeTtsSession = ttsSession;
    this.applyState({
      type: "assistant-thinking-started"
    });

    this.responseSequence = (async () => {
      try {
        const finalText = await Promise.race([
          this.input.conversation.reply({
            text,
            attachments,
            channel: "console",
            resourceId: target.resourceId,
            threadId: target.threadId,
            assistantPersistence: "caller",
            userMetadata: {
              voice: {
                source: "voice",
                sessionId,
                mode: this.state.mode,
                interrupted: false,
                playedTextLength: 0,
                asrProvider: config.voice.asrProvider,
                ttsProvider: config.voice.ttsProvider
              }
            },
            voiceContext: metadata
              ? {
                  provider: config.voice.asrProvider,
                  metadata
                }
              : undefined,
            abortSignal: replyAbortController.signal,
            stream: {
              onVisibleTextDelta: (delta) => {
                if (!this.isAssistantGenerationCurrent(assistantGeneration)) {
                  return;
                }

                this.refreshAssistantProgressWatchdog(assistantGeneration);
                this.llmVisibleText += delta;
                this.state = {
                  ...this.state,
                  assistantTranscript: this.llmVisibleText,
                  updatedAt: nowIso()
                };
                this.emit({
                  type: "assistant-transcript",
                  text: this.llmVisibleText,
                  isFinal: false,
                  timestamp: nowIso()
                });
                this.emitState();
                for (const chunk of chunker.push(delta)) {
                  void this.enqueueTtsChunk(chunk, ttsSession, playbackGeneration);
                }
              },
              onVisibleTextFinal: (visibleText) => {
                if (!this.isAssistantGenerationCurrent(assistantGeneration)) {
                  return;
                }

                this.refreshAssistantProgressWatchdog(assistantGeneration);
                this.llmVisibleText = visibleText;
              },
              onAbortVisibleText: (visibleText) => {
                if (!this.isAssistantGenerationCurrent(assistantGeneration)) {
                  return;
                }

                this.llmVisibleText = visibleText;
              }
            }
          }),
          assistantProgressWatchdog
        ]);

        if (!this.isAssistantGenerationCurrent(assistantGeneration)) {
          return;
        }

        for (const chunk of chunker.flush()) {
          await this.enqueueTtsChunk(chunk, ttsSession, playbackGeneration);
        }

        if (!this.isAssistantGenerationCurrent(assistantGeneration)) {
          return;
        }

        this.llmVisibleText = finalText;
        this.llmFinished = true;
        this.emit({
          type: "assistant-transcript",
          text: finalText,
          isFinal: true,
          timestamp: nowIso()
        });
        this.state = {
          ...this.state,
          assistantTranscript: finalText,
          updatedAt: nowIso()
        };
        this.emitState();
        await this.maybeFinalizeAssistantTurn();
      } catch (error) {
        if (isTimeoutError(error, ASSISTANT_PROGRESS_TIMEOUT_ERROR)) {
          if (this.isAssistantGenerationCurrent(assistantGeneration)) {
            await this.recoverFromAssistantTimeout();
          }
          return;
        }

        if (!this.isAssistantGenerationCurrent(assistantGeneration)) {
          return;
        }

        if (replyAbortController.signal.aborted) {
          await this.persistInterruptedAssistantTurn();
          return;
        }

        if (isAbortLikeError(error)) {
          await this.persistInterruptedAssistantTurn();
          this.clearCurrentTurnTranscripts();
          this.transitionToReadyState();
          await this.notifyStatusChange();
          return;
        }

        this.fail(error instanceof Error ? error.message : "实时语音回复失败");
      } finally {
        if (this.isAssistantGenerationCurrent(assistantGeneration)) {
          this.clearAssistantProgressWatchdog();
          this.llmFinished = true;
        }
        await ttsSession.close();
        if (this.activeTtsSession === ttsSession) {
          this.activeTtsSession = null;
        }
      }
    })();
    await this.responseSequence;
  }

  private async enqueueTtsChunk(
    text: string,
    session: StreamingTtsSession,
    playbackGeneration = this.playbackGeneration
  ): Promise<void> {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }

    this.ttsSequence = this.ttsSequence.then(async () => {
      if (!this.isPlaybackGenerationActive(session, playbackGeneration)) {
        return;
      }

      this.pendingSynthesisCount += 1;
      try {
        const audio = await session.synthesizeChunk(normalized);
        if (!this.isPlaybackGenerationActive(session, playbackGeneration)) {
          return;
        }

        const id = `voice-playback-${randomUUID()}`;
        const queued = await this.enqueuePlayback({
          id,
          audioBase64: audio.toString("base64"),
          text: normalized,
          mimeType: "audio/mpeg",
          generation: playbackGeneration
        });
        if (!queued) {
          return;
        }

        this.pendingPlaybackTexts.set(id, normalized);
        this.syncPlaybackStartWatchdog(playbackGeneration);
        this.refreshAssistantProgressWatchdog(this.assistantGeneration);
        this.state = {
          ...this.state,
          playback: {
            ...this.state.playback,
            queueLength: this.pendingPlaybackTexts.size
          },
          updatedAt: nowIso()
        };
        this.emitState();
      } catch (error) {
        this.input.logger.warn("realtime-voice", "tts-chunk-failed", {
          textLength: normalized.length
        }, error);
      } finally {
        this.pendingSynthesisCount = Math.max(0, this.pendingSynthesisCount - 1);
      }
    });

    await this.ttsSequence;
  }

  private async maybeFinalizeAssistantTurn(): Promise<void> {
    if (!this.llmFinished || this.pendingSynthesisCount > 0 || this.pendingPlaybackTexts.size > 0) {
      return;
    }

    this.clearPlaybackStartWatchdog();
    if (this.assistantCommitPersisted || !this.state.sessionId || !this.state.target) {
      return;
    }

    this.clearAssistantProgressWatchdog();
    this.assistantCommitPersisted = true;
    if (this.llmVisibleText.trim()) {
      const userTranscript = this.state.userTranscript;
      await this.input.conversation.rememberAssistantMessage({
        threadId: this.state.target.threadId,
        resourceId: this.state.target.resourceId,
        channel: "console",
        text: this.llmVisibleText,
        metadata: {
          channel: "console",
          voice: {
            source: "voice",
            sessionId: this.state.sessionId,
            mode: this.state.mode,
            interrupted: false,
            playedTextLength: this.llmVisibleText.length,
            asrProvider: this.input.getConfig().voice.asrProvider,
            ttsProvider: this.input.getConfig().voice.ttsProvider
          }
        }
      });
      await Promise.resolve(this.assistantReplyHook?.({
        channel: "console",
        userText: userTranscript,
        assistantText: this.llmVisibleText
      }));
      await this.input.onAssistantMessage?.();
    }

    this.clearCurrentTurnTranscripts();
    this.applyState({
      type: "assistant-playback-finished"
    });
    await this.notifyStatusChange();
  }

  private async persistInterruptedAssistantTurn(): Promise<void> {
    if (this.assistantCommitPersisted || !this.state.sessionId || !this.state.target) {
      return;
    }

    const commit = buildInterruptedAssistantCommit({
      fullText: this.llmVisibleText,
      playedText: this.playedAssistantText,
      sessionId: this.state.sessionId,
      mode: this.state.mode,
      asrProvider: this.input.getConfig().voice.asrProvider,
      ttsProvider: this.input.getConfig().voice.ttsProvider
    });

    if (!commit.text.trim()) {
      return;
    }

    this.assistantCommitPersisted = true;
    const userTranscript = this.state.userTranscript;
    await this.input.conversation.rememberAssistantMessage({
      threadId: this.state.target.threadId,
      resourceId: this.state.target.resourceId,
      channel: "console",
      text: commit.text,
      metadata: {
        channel: "console",
        ...commit.metadata
      }
    });
    await Promise.resolve(this.assistantReplyHook?.({
      channel: "console",
      userText: userTranscript,
      assistantText: commit.text
    }));
    await this.input.onAssistantMessage?.();
  }

  private async abortActiveResponse(reason: "vad" | "manual" | "system"): Promise<void> {
    this.clearAssistantProgressWatchdog();
    this.clearPlaybackStartWatchdog();
    this.invalidateAssistantGeneration();
    if (this.replyAbortController && !this.replyAbortController.signal.aborted) {
      this.replyAbortController.abort();
    }
    this.replyAbortController = null;
    const activeTtsSession = this.activeTtsSession;
    this.activeTtsSession = null;
    this.playbackGeneration += 1;
    await this.persistInterruptedAssistantTurn();
    this.llmFinished = true;
    this.ttsSequence = Promise.resolve();
    this.pendingSynthesisCount = 0;
    this.pendingPlaybackTexts.clear();
    await activeTtsSession?.close().catch(() => undefined);
    this.state = {
      ...this.state,
      lastInterruptReason: reason,
      updatedAt: nowIso()
    };
  }

  private beginPlaybackGeneration(): number {
    this.playbackGeneration += 1;
    return this.playbackGeneration;
  }

  private isPlaybackGenerationActive(
    session: StreamingTtsSession,
    playbackGeneration: number
  ): boolean {
    return (
      this.playbackGeneration === playbackGeneration &&
      this.activeTtsSession === session &&
      this.state.sessionId !== null
    );
  }

  private isPlaybackGenerationCurrent(generation: number): boolean {
    return generation === this.playbackGeneration;
  }

  private async enqueuePlayback(input: {
    id: string;
    audioBase64: string;
    text: string;
    mimeType: string;
    generation: number;
  }): Promise<boolean> {
    if (!this.playbackBridge) {
      return false;
    }

    try {
      return (
        (await this.playbackBridge.enqueueSpeech({
          chunkId: input.id,
          audioBase64: input.audioBase64,
          text: input.text,
          mimeType: input.mimeType,
          generation: input.generation
        })) !== false
      );
    } catch (error) {
      this.input.logger.warn("realtime-voice", "enqueue-playback-failed", {
        textLength: input.text.length,
        generation: input.generation
      }, error);
      return false;
    }
  }

  private async clearPlayback(reason: "vad" | "manual" | "system"): Promise<void> {
    if (!this.playbackBridge) {
      return;
    }

    try {
      await this.playbackBridge.clearSpeech({
        generation: this.playbackGeneration,
        reason
      });
    } catch (error) {
      this.input.logger.warn("realtime-voice", "clear-playback-failed", {
        generation: this.playbackGeneration,
        reason
      }, error);
    }
  }

  private applyState(event: Parameters<typeof reduceVoiceSessionState>[1]): void {
    this.state = reduceVoiceSessionState(this.state, event);
    this.emitState();
  }

  private fail(message: string): void {
    this.input.logger.warn("realtime-voice", "session:error", {
      phase: this.state.phase
    }, new Error(message));
    this.state = reduceVoiceSessionState(this.state, {
      type: "error",
      message
    });
    this.emit({
      type: "error",
      message,
      timestamp: nowIso()
    });
    this.emitState();
  }

  private async notifyStatusChange(): Promise<void> {
    await this.input.onStatusChange?.();
  }
}
