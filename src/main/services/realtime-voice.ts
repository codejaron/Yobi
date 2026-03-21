import { randomUUID } from "node:crypto";
import type {
  AppConfig,
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
import { SentenceChunkBuffer } from "./realtime-voice-chunker";
import { shouldAutoStartVoiceSession } from "./realtime-voice-lifecycle";
import { buildInterruptedAssistantCommit } from "./realtime-voice-persistence";
import { createVoiceSessionState, reduceVoiceSessionState } from "./realtime-voice-state";
import {
  createVoiceActivityDetector,
  getVoiceActivityDetectorConfig,
  type VoiceActivityDetector,
  type VoiceActivityDetectorConfig
} from "./realtime-voice-vad";
import { VoiceHostWindowController, type VoiceHostMessage } from "./voice-host-window";
import { VoiceProviderRouter, type StreamingAsrSession, type StreamingTtsSession } from "./voice-router";

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
  createVad?: (input: {
    config: VoiceActivityDetectorConfig;
    logger: AppLogger;
  }) => Promise<VoiceActivityDetector>;
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

export class RealtimeVoiceService {
  private readonly host: VoiceHostWindowController;
  private readonly listeners = new Set<(event: VoiceSessionEvent) => void>();
  private assistantReplyHook:
    | ((input: {
        channel: RuntimeInboundChannel;
        userText: string;
        assistantText: string;
      }) => Promise<void> | void)
    | null = null;
  private state: VoiceSessionState;
  private pttHeld = false;
  private vad: VoiceActivityDetector | null = null;
  private vadPromise: Promise<VoiceActivityDetector> | null = null;
  private vadConfig: VoiceActivityDetectorConfig | null = null;
  private speechActive = false;
  private speechStartedAtMs = 0;
  private preRollBuffers: Buffer[] = [];
  private speechBuffers: Buffer[] = [];
  private activeAsrSession: StreamingAsrSession | null = null;
  private activeTtsSession: StreamingTtsSession | null = null;
  private replyAbortController: AbortController | null = null;
  private responseSequence = Promise.resolve();
  private ttsSequence = Promise.resolve();
  private pendingSynthesisCount = 0;
  private pendingPlaybackTexts = new Map<string, string>();
  private playbackGeneration = 0;
  private playedChunkIds = new Set<string>();
  private llmFinished = false;
  private llmVisibleText = "";
  private playedAssistantText = "";
  private assistantCommitPersisted = false;

  constructor(private readonly input: RealtimeVoiceServiceInput) {
    this.host = new VoiceHostWindowController(input.logger);
    this.state = createEmptyVoiceState(this.input.getConfig().realtimeVoice.mode);
    this.host.onMessage((message) => {
      void this.handleHostMessage(message).catch((error) => {
        this.fail(error instanceof Error ? error.message : "实时语音处理失败");
      });
    });
  }

  start(): void {
    const config = this.input.getConfig();
    this.state = createEmptyVoiceState(config.realtimeVoice.mode);
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
    this.host.close();
    this.disposeVad();
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
    this.applyState({
      type: "session-started"
    });
    this.resetSpeechTracking();

    if (mode === "free") {
      await this.ensureVadReady();
      await this.host.send({
        type: "start-capture",
        aecEnabled: config.realtimeVoice.aecEnabled
      });
    }

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
    await this.host.send({
      type: "stop-capture"
    }).catch(() => undefined);
    await this.host.send({
      type: "clear-playback"
    }).catch(() => undefined);
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
    await this.host.send({
      type: "clear-playback"
    }).catch(() => undefined);
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
      await this.host.send({
        type: "start-capture",
        aecEnabled: this.input.getConfig().realtimeVoice.aecEnabled
      });
    } else if (!this.pttHeld) {
      await this.host.send({
        type: "stop-capture"
      }).catch(() => undefined);
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
      await this.host.send({
        type: "start-capture",
        aecEnabled: this.input.getConfig().realtimeVoice.aecEnabled
      });
      return;
    }

    if (!this.pttHeld) {
      return;
    }

    this.pttHeld = false;
    await this.host.send({
      type: "stop-capture"
    }).catch(() => undefined);
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
    await this.host.send({
      type: "enqueue-playback",
      id: `standalone-${randomUUID()}`,
      audioBase64: audio.toString("base64"),
      text: normalized,
      mimeType: "audio/mpeg"
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
    this.preRollBuffers = [];
    this.speechBuffers = [];
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

    this.speechActive = true;
    this.speechStartedAtMs = Date.now();
    this.speechBuffers = [];
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

    this.speechActive = false;
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
      const recognized = await asrSession.flush();
      const text = recognized.text.trim();
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
        timestamp: nowIso()
      });
      this.emitState();
      await this.handleUserTurn(text, recognized.metadata);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "语音识别失败");
    } finally {
      this.preRollBuffers = [];
      this.speechBuffers = [];
      this.vad?.reset();
    }
  }

  private async handleHostMessage(message: VoiceHostMessage): Promise<void> {
    if (message.type === "pcm-frame") {
      const chunk = Buffer.from(message.pcm);
      await this.handlePcmFrame(chunk, message.sampleRate);
      return;
    }

    if (message.type === "capture-started") {
      return;
    }

    if (message.type === "capture-stopped") {
      return;
    }

    if (message.type === "capture-error") {
      this.input.logger.warn("realtime-voice", "capture:error", undefined, new Error(message.message));
      this.fail(message.message);
      return;
    }

    if (message.type === "playback-started") {
      this.pendingPlaybackTexts.set(message.id, message.text);
      if (!this.playedChunkIds.has(message.id)) {
        this.playedChunkIds.add(message.id);
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

    if (message.type === "playback-ended") {
      this.pendingPlaybackTexts.delete(message.id);
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
      await this.maybeFinalizeAssistantTurn();
      return;
    }

    if (message.type === "playback-cleared") {
      this.pendingPlaybackTexts.clear();
      this.state = {
        ...this.state,
        playback: {
          active: false,
          queueLength: message.queueLength,
          level: 0,
          currentText: ""
        },
        updatedAt: nowIso()
      };
      this.emitState();
      return;
    }

    if (message.type === "speech-level") {
      this.state = reduceVoiceSessionState(this.state, {
        type: "playback-level",
        level: message.level,
        queueLength: message.queueLength,
        currentText: message.currentText
      });
      this.emit({
        type: "speech-level",
        level: message.level,
        timestamp: nowIso()
      });
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

    if (message.type === "playback-error") {
      this.fail(message.message);
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
    }

    const config = this.input.getConfig().realtimeVoice;
    if (this.speechActive && nowMs - this.speechStartedAtMs >= config.maxUtteranceMs) {
      await this.finishSpeech();
      return;
    }

    if (this.speechActive && result.speechEnded) {
      await this.finishSpeech();
    }
  }

  private async handleUserTurn(
    text: string,
    metadata: VoiceSessionState["userTranscriptMetadata"] = null
  ): Promise<void> {
    const sessionId = this.state.sessionId;
    const target = this.state.target;
    if (!sessionId || !target) {
      return;
    }

    const config = this.input.getConfig();
    await this.input.memory.rememberMessage({
      threadId: target.threadId,
      resourceId: target.resourceId,
      role: "user",
      text,
      metadata: {
        channel: "console",
        voice: {
          source: "voice",
          sessionId,
          mode: this.state.mode,
          interrupted: false,
          playedTextLength: 0,
          asrProvider: config.voice.asrProvider,
          ttsProvider: config.voice.ttsProvider
        },
        ...(metadata
          ? {
              speechRecognition: {
                provider: config.voice.asrProvider,
                ...metadata
              }
            }
          : {})
      }
    });
    this.input.logger.info("realtime-voice", "llm:user-input", {
      sessionId,
      textLength: text.length,
      textPreview: toLogPreview(text)
    });
    await this.input.onRecordUserActivity?.({
      channel: "console",
      text
    });

    this.replyAbortController = new AbortController();
    this.llmFinished = false;
    this.llmVisibleText = "";
    this.playedAssistantText = "";
    this.assistantCommitPersisted = false;
    this.ttsSequence = Promise.resolve();
    this.pendingPlaybackTexts.clear();
    this.playedChunkIds.clear();
    const playbackGeneration = this.beginPlaybackGeneration();

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
        const finalText = await this.input.conversation.reply({
          text,
          channel: "console",
          resourceId: target.resourceId,
          threadId: target.threadId,
          persistUserMessage: false,
          assistantPersistence: "caller",
          voiceContext: metadata
            ? {
                provider: config.voice.asrProvider,
                metadata
              }
            : undefined,
          abortSignal: this.replyAbortController?.signal,
          stream: {
            onVisibleTextDelta: (delta) => {
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
              this.llmVisibleText = visibleText;
            },
            onAbortVisibleText: (visibleText) => {
              this.llmVisibleText = visibleText;
            }
          }
        });

        for (const chunk of chunker.flush()) {
          await this.enqueueTtsChunk(chunk, ttsSession, playbackGeneration);
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
        if (this.replyAbortController?.signal.aborted) {
          await this.persistInterruptedAssistantTurn();
          return;
        }

        this.fail(error instanceof Error ? error.message : "实时语音回复失败");
      } finally {
        this.llmFinished = true;
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
        this.pendingPlaybackTexts.set(id, normalized);
        await this.host.send({
          type: "enqueue-playback",
          id,
          audioBase64: audio.toString("base64"),
          text: normalized,
          mimeType: "audio/mpeg"
        });
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

    if (this.assistantCommitPersisted || !this.state.sessionId || !this.state.target) {
      return;
    }

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
