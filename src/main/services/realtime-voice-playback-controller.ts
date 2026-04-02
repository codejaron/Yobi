import type { PetVoiceEvent } from "@shared/pet-events";
import type { AppLogger } from "./logger";

export interface RealtimeVoicePlaybackBridge {
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

interface PlaybackChunk {
  chunkId: string;
  audioBase64: string;
  text: string;
  mimeType: string;
  generation: number;
}

export interface RealtimeVoicePlaybackControllerState {
  generation: number;
  active: boolean;
  currentChunkId: string | null;
  currentText: string;
  queuedCount: number;
  pendingCount: number;
}

export type RealtimeVoicePlaybackControllerEvent =
  | {
      type: "chunk-dispatched";
      chunkId: string;
      text: string;
      generation: number;
      state: RealtimeVoicePlaybackControllerState;
    }
  | {
      type: "chunk-started";
      chunkId: string;
      text: string;
      generation: number;
      state: RealtimeVoicePlaybackControllerState;
    }
  | {
      type: "chunk-ended";
      chunkId: string;
      text: string;
      generation: number;
      state: RealtimeVoicePlaybackControllerState;
    }
  | {
      type: "chunk-error";
      chunkId: string;
      text: string;
      generation: number;
      message: string;
      state: RealtimeVoicePlaybackControllerState;
    }
  | {
      type: "cleared";
      generation: number;
      state: RealtimeVoicePlaybackControllerState;
    }
  | {
      type: "reference-frame";
      generation: number;
      pcm: Buffer;
      sampleRate: number;
      state: RealtimeVoicePlaybackControllerState;
    }
  | {
      type: "start-timeout";
      chunkId: string;
      text: string;
      generation: number;
      state: RealtimeVoicePlaybackControllerState;
    };

interface RealtimeVoicePlaybackControllerInput {
  bridge: RealtimeVoicePlaybackBridge | null;
  logger: AppLogger;
  startTimeoutMs?: number;
}

const DEFAULT_START_TIMEOUT_MS = 500;

export class RealtimeVoicePlaybackController {
  private readonly bridge: RealtimeVoicePlaybackBridge | null;
  private readonly logger: AppLogger;
  private readonly startTimeoutMs: number;
  private readonly listeners = new Set<(event: RealtimeVoicePlaybackControllerEvent) => void>();
  private readonly disposeBridgeListener: (() => void) | null;
  private queue: PlaybackChunk[] = [];
  private current: PlaybackChunk | null = null;
  private currentStarted = false;
  private dispatching = false;
  private generation = 0;
  private startTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(input: RealtimeVoicePlaybackControllerInput) {
    this.bridge = input.bridge ?? null;
    this.logger = input.logger;
    this.startTimeoutMs = Math.max(20, input.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    this.disposeBridgeListener = this.bridge?.onVoiceEvent?.((event) => {
      void this.handleBridgeEvent(event).catch((error) => {
        this.logger.warn("realtime-voice-playback", "bridge-event-failed", undefined, error);
      });
    }) ?? null;
  }

  dispose(): void {
    this.clearStartTimer();
    this.disposeBridgeListener?.();
    this.listeners.clear();
    this.queue = [];
    this.current = null;
    this.currentStarted = false;
  }

  onEvent(listener: (event: RealtimeVoicePlaybackControllerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  beginGeneration(): number {
    this.clearStartTimer();
    this.queue = [];
    this.current = null;
    this.currentStarted = false;
    this.generation += 1;
    return this.generation;
  }

  getGeneration(): number {
    return this.generation;
  }

  getState(): RealtimeVoicePlaybackControllerState {
    return {
      generation: this.generation,
      active: this.currentStarted,
      currentChunkId: this.current?.chunkId ?? null,
      currentText: this.currentStarted ? this.current?.text ?? "" : "",
      queuedCount: this.queue.length,
      pendingCount: this.queue.length + (this.current ? 1 : 0)
    };
  }

  getPendingCount(): number {
    return this.getState().pendingCount;
  }

  hasPendingChunk(chunkId: string, generation: number): boolean {
    if (!chunkId || generation !== this.generation) {
      return false;
    }

    if (this.current?.chunkId === chunkId) {
      return true;
    }

    return this.queue.some((item) => item.chunkId === chunkId);
  }

  async enqueue(chunk: PlaybackChunk): Promise<boolean> {
    if (!this.bridge || chunk.generation !== this.generation) {
      return false;
    }

    this.queue.push({
      ...chunk
    });
    await this.flush();
    return true;
  }

  async clear(reason?: string): Promise<void> {
    if (!this.bridge) {
      this.clearLocalState();
      return;
    }

    const generation = this.generation;
    this.clearLocalState();
    this.emit({
      type: "cleared",
      generation,
      state: this.getState()
    });

    try {
      await this.bridge.clearSpeech({
        generation,
        reason
      });
    } catch (error) {
      this.logger.warn("realtime-voice-playback", "clear-failed", {
        generation,
        reason
      }, error);
    }
  }

  async handleBridgeEvent(event: PetVoiceEvent): Promise<void> {
    if (event.type !== "speech-reference-frame") {
      this.logger.info("realtime-voice-playback", "bridge-event", {
        eventType: event.type,
        eventGeneration: event.generation,
        controllerGeneration: this.generation,
        currentChunkId: this.current?.chunkId ?? null,
        currentStarted: this.currentStarted,
        queuedCount: this.queue.length
      });
    }

    if (event.generation !== this.generation) {
      if (event.type !== "speech-reference-frame") {
        this.logger.info("realtime-voice-playback", "bridge-event-ignored", {
          reason: "generation-mismatch",
          eventType: event.type,
          eventGeneration: event.generation,
          controllerGeneration: this.generation
        });
      }
      return;
    }

    if (event.type === "speech-reference-frame") {
      const current = this.current;
      if (current && !this.currentStarted) {
        this.currentStarted = true;
        this.clearStartTimer();
        this.logger.info("realtime-voice-playback", "bridge-event-promote-start", {
          chunkId: current.chunkId,
          generation: current.generation,
          queuedCount: this.queue.length
        });
        this.emit({
          type: "chunk-started",
          chunkId: current.chunkId,
          text: current.text,
          generation: current.generation,
          state: this.getState()
        });
      }
      this.emit({
        type: "reference-frame",
        generation: event.generation,
        pcm: Buffer.from(event.pcm),
        sampleRate: event.sampleRate,
        state: this.getState()
      });
      return;
    }

    if (event.type === "speech-playback-cleared") {
      this.clearLocalState();
      this.emit({
        type: "cleared",
        generation: event.generation,
        state: this.getState()
      });
      return;
    }

    const current = this.current;
    if (!current || current.chunkId !== event.chunkId) {
      this.logger.info("realtime-voice-playback", "bridge-event-ignored", {
        reason: current ? "chunk-mismatch" : "missing-current",
        eventType: event.type,
        eventChunkId: "chunkId" in event ? event.chunkId : null,
        currentChunkId: current?.chunkId ?? null,
        generation: event.generation
      });
      return;
    }

    if (event.type === "speech-playback-started") {
      if (this.currentStarted) {
        this.logger.info("realtime-voice-playback", "bridge-event-ignored", {
          reason: "already-started",
          eventType: event.type,
          chunkId: current.chunkId,
          generation: current.generation
        });
        return;
      }

      this.currentStarted = true;
      this.clearStartTimer();
      this.logger.info("realtime-voice-playback", "bridge-event-started", {
        chunkId: current.chunkId,
        generation: current.generation,
        queuedCount: this.queue.length
      });
      this.emit({
        type: "chunk-started",
        chunkId: current.chunkId,
        text: current.text,
        generation: current.generation,
        state: this.getState()
      });
      return;
    }

    if (event.type === "speech-playback-ended") {
      this.clearStartTimer();
      this.current = null;
      this.currentStarted = false;
      this.logger.info("realtime-voice-playback", "bridge-event-ended", {
        chunkId: current.chunkId,
        generation: current.generation,
        queuedCount: this.queue.length
      });
      this.emit({
        type: "chunk-ended",
        chunkId: current.chunkId,
        text: current.text,
        generation: current.generation,
        state: this.getState()
      });
      await this.flush();
      return;
    }

    if (event.type === "speech-playback-error") {
      this.clearStartTimer();
      this.current = null;
      this.currentStarted = false;
      this.logger.info("realtime-voice-playback", "bridge-event-error", {
        chunkId: current.chunkId,
        generation: current.generation,
        message: event.message,
        queuedCount: this.queue.length
      });
      this.emit({
        type: "chunk-error",
        chunkId: current.chunkId,
        text: current.text,
        generation: current.generation,
        message: event.message,
        state: this.getState()
      });
      await this.flush();
    }
  }

  private clearLocalState(): void {
    this.clearStartTimer();
    this.queue = [];
    this.current = null;
    this.currentStarted = false;
  }

  private async flush(): Promise<void> {
    if (this.dispatching || this.current || this.queue.length === 0 || !this.bridge) {
      return;
    }

    this.dispatching = true;
    try {
      while (!this.current && this.queue.length > 0) {
        const next = this.queue.shift();
        if (!next || next.generation !== this.generation) {
          continue;
        }

        this.current = next;
        this.currentStarted = false;
        this.emit({
          type: "chunk-dispatched",
          chunkId: next.chunkId,
          text: next.text,
          generation: next.generation,
          state: this.getState()
        });

        let queued = false;
        try {
          queued = (await this.bridge.enqueueSpeech({
            chunkId: next.chunkId,
            audioBase64: next.audioBase64,
            text: next.text,
            mimeType: next.mimeType,
            generation: next.generation
          })) !== false;
        } catch (error) {
          this.logger.warn("realtime-voice-playback", "enqueue-failed", {
            chunkId: next.chunkId,
            generation: next.generation
          }, error);
        }

        if (!queued) {
          this.current = null;
          this.currentStarted = false;
          this.emit({
            type: "chunk-error",
            chunkId: next.chunkId,
            text: next.text,
            generation: next.generation,
            message: "playback-enqueue-rejected",
            state: this.getState()
          });
          continue;
        }

        this.armStartTimer(next);
      }
    } finally {
      this.dispatching = false;
    }
  }

  private armStartTimer(chunk: PlaybackChunk): void {
    this.clearStartTimer();
    this.startTimer = setTimeout(() => {
      if (!this.current || this.current.chunkId !== chunk.chunkId || this.currentStarted) {
        return;
      }

      this.startTimer = null;
      this.emit({
        type: "start-timeout",
        chunkId: chunk.chunkId,
        text: chunk.text,
        generation: chunk.generation,
        state: this.getState()
      });
    }, this.startTimeoutMs);
    this.startTimer.unref?.();
  }

  private clearStartTimer(): void {
    if (!this.startTimer) {
      return;
    }

    clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  private emit(event: RealtimeVoicePlaybackControllerEvent): void {
    if (event.type !== "reference-frame") {
      this.logger.info("realtime-voice-playback", "controller-event", {
        eventType: event.type,
        generation: event.generation,
        chunkId: "chunkId" in event ? event.chunkId : null,
        currentChunkId: this.current?.chunkId ?? null,
        currentStarted: this.currentStarted,
        queuedCount: this.queue.length,
        pendingCount: event.state.pendingCount
      });
    }

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn("realtime-voice-playback", "listener-failed", undefined, error);
      }
    }
  }
}
