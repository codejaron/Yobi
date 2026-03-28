import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { resolveNativeAudioHelperPath } from "./native-audio-helper-path";
import type { AppLogger } from "./logger";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return {
    promise,
    resolve,
    reject
  };
}

export interface NativeAudioCaptureFrame {
  pcm: Buffer;
  sampleRate: number;
}

export interface NativeAudioCaptureSegmentResult {
  pcm16Base64: string;
  durationMs: number;
  sampleRate: number;
}

type NativeAudioHelperCommand =
  | { command: "ensure_open" }
  | { command: "close" }
  | { command: "start_segment" }
  | { command: "stop_segment" }
  | { command: "cancel_segment" }
  | { command: "start_stream" }
  | { command: "stop_stream" }
  | { command: "shutdown" };

type NativeAudioHelperEvent =
  | { type: "ready" }
  | { type: "opened" }
  | { type: "pcm_frame"; pcm16Base64: string; sampleRate: number }
  | { type: "segment_result"; pcm16Base64: string; durationMs: number; sampleRate: number }
  | { type: "error"; message: string }
  | { type: "closed" };

type NativeAudioMode = "segment" | "stream" | null;

export interface NativeAudioCaptureBackend {
  isNativeSupported(): boolean;
  onPcmFrame(listener: (frame: NativeAudioCaptureFrame) => void): () => void;
  warmup?(): Promise<void>;
  prepare?(): Promise<void>;
  startSegment(): Promise<void>;
  stopSegment(): Promise<NativeAudioCaptureSegmentResult>;
  cancelSegment(): Promise<{ accepted: boolean }>;
  startStream(): Promise<void>;
  stopStream(): Promise<void>;
  stop(): Promise<void>;
}

interface HelperReadable {
  on: (event: "data", listener: (chunk: string | Buffer) => void) => void;
  setEncoding?: (encoding: BufferEncoding) => void;
}

interface HelperWritable {
  write: (chunk: string) => boolean;
  end?: () => void;
}

interface HelperChild {
  stdin: HelperWritable;
  stdout: HelperReadable;
  stderr: HelperReadable;
  on: (event: "close" | "error", listener: (...args: any[]) => void) => void;
  kill: () => boolean;
}

interface NativeAudioCaptureServiceInput {
  logger: Pick<AppLogger, "info" | "warn" | "error">;
  keepAliveMs?: number;
  platform?: NodeJS.Platform;
  resolveHelperPath?: () => Promise<string>;
  spawnProcess?: (helperPath: string) => HelperChild;
}

export class NativeAudioCaptureService implements NativeAudioCaptureBackend {
  private readonly frameListeners = new Set<(frame: NativeAudioCaptureFrame) => void>();
  private commandChain: Promise<void> = Promise.resolve();
  private child: HelperChild | null = null;
  private outputBuffer = "";
  private stderrBuffer = "";
  private helperReady = false;
  private warming: Deferred<void> | null = null;
  private opening: Deferred<void> | null = null;
  private pendingSegmentResult: Deferred<NativeAudioCaptureSegmentResult> | null = null;
  private activeMode: NativeAudioMode = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private shutdownRequested = false;
  private opened = false;

  constructor(private readonly input: NativeAudioCaptureServiceInput) {}

  isNativeSupported(): boolean {
    const platform = this.input.platform ?? process.platform;
    return platform === "darwin" || platform === "win32";
  }

  onPcmFrame(listener: (frame: NativeAudioCaptureFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  async warmup(): Promise<void> {
    if (!this.isNativeSupported()) {
      return;
    }

    await this.runSerialized(async () => {
      await this.ensureProcess();
    });
  }

  async prepare(): Promise<void> {
    if (!this.isNativeSupported()) {
      return;
    }

    await this.runSerialized(async () => {
      this.clearIdleTimer();
      await this.ensureOpen();
    });
  }

  async startSegment(): Promise<void> {
    await this.runSerialized(async () => {
      if (!this.isNativeSupported()) {
        throw new Error("当前平台不支持原生录音采集。");
      }
      if (this.activeMode === "stream") {
        throw new Error("语音采集正忙，请稍后再试。");
      }

      this.clearIdleTimer();
      await this.ensureOpen();
      if (this.activeMode === "segment") {
        return;
      }

      await this.sendCommand({
        command: "start_segment"
      });
      this.activeMode = "segment";
    });
  }

  async stopSegment(): Promise<NativeAudioCaptureSegmentResult> {
    return this.runSerialized(async () => {
      if (this.activeMode !== "segment") {
        throw new Error("当前没有正在进行的段录音。");
      }

      const deferred = createDeferred<NativeAudioCaptureSegmentResult>();
      this.pendingSegmentResult = deferred;
      await this.sendCommand({
        command: "stop_segment"
      });

      try {
        return await deferred.promise;
      } finally {
        this.pendingSegmentResult = null;
        this.activeMode = null;
        this.armIdleTimer();
      }
    });
  }

  async cancelSegment(): Promise<{ accepted: boolean }> {
    return this.runSerialized(async () => {
      if (this.activeMode !== "segment") {
        return {
          accepted: false
        };
      }

      await this.sendCommand({
        command: "cancel_segment"
      });
      this.activeMode = null;
      this.pendingSegmentResult?.reject(new Error("录音已取消。"));
      this.pendingSegmentResult = null;
      this.armIdleTimer();
      return {
        accepted: true
      };
    });
  }

  async startStream(): Promise<void> {
    await this.runSerialized(async () => {
      if (!this.isNativeSupported()) {
        throw new Error("当前平台不支持原生流式录音。");
      }
      if (this.activeMode === "segment") {
        throw new Error("段录音进行中，无法启动实时语音。");
      }

      this.clearIdleTimer();
      await this.ensureOpen();
      if (this.activeMode === "stream") {
        return;
      }

      await this.sendCommand({
        command: "start_stream"
      });
      this.activeMode = "stream";
    });
  }

  async stopStream(): Promise<void> {
    await this.runSerialized(async () => {
      if (this.activeMode !== "stream") {
        return;
      }

      await this.sendCommand({
        command: "stop_stream"
      }).catch(() => undefined);
      this.activeMode = null;
      this.armIdleTimer();
    });
  }

  async stop(): Promise<void> {
    this.clearIdleTimer();
    await this.runSerialized(async () => {
      await this.requestShutdown(true);
    });
  }

  private async ensureOpen(): Promise<void> {
    await this.ensureProcess();
    if (this.opened) {
      return;
    }

    if (this.opening) {
      return this.opening.promise;
    }

    const deferred = createDeferred<void>();
    this.opening = deferred;
    try {
      await this.sendCommand({
        command: "ensure_open"
      });
      await deferred.promise;
    } catch (error) {
      this.opening = null;
      throw error;
    }
  }

  private async ensureProcess(): Promise<void> {
    if (this.child && this.helperReady) {
      return;
    }

    if (this.warming) {
      return this.warming.promise;
    }

    const deferred = createDeferred<void>();
    this.warming = deferred;
    try {
      if (!this.child) {
        const helperPath = await (this.input.resolveHelperPath ?? resolveNativeAudioHelperPath)();
        this.child = (this.input.spawnProcess ?? defaultSpawnProcess)(helperPath);
        this.attachChild(this.child);
      }

      await deferred.promise;
    } catch (error) {
      this.warming = null;
      throw error;
    }
  }

  private attachChild(child: HelperChild): void {
    child.stdout.setEncoding?.("utf8");
    child.stderr.setEncoding?.("utf8");
    child.stdout.on("data", (chunk) => {
      this.handleStdout(chunk);
    });
    child.stderr.on("data", (chunk) => {
      this.handleStderr(chunk);
    });
    child.on("close", () => {
      this.handleClosed();
    });
    child.on("error", (error) => {
      this.handleFailure(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private handleStdout(chunk: string | Buffer): void {
    this.outputBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    while (true) {
      const newlineIndex = this.outputBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }

      const line = this.outputBuffer.slice(0, newlineIndex).trim();
      this.outputBuffer = this.outputBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      this.handleEvent(parseEvent(line));
    }
  }

  private handleStderr(chunk: string | Buffer): void {
    this.stderrBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    while (true) {
      const newlineIndex = this.stderrBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }

      const line = this.stderrBuffer.slice(0, newlineIndex).trim();
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);
      if (line) {
        this.input.logger.warn("native-audio", "helper-stderr", {
          message: line
        });
      }
    }
  }

  private handleEvent(event: NativeAudioHelperEvent): void {
    if (event.type === "ready") {
      this.input.logger.info("native-audio", "helper-ready");
      this.helperReady = true;
      this.warming?.resolve();
      this.warming = null;
      return;
    }

    if (event.type === "opened") {
      this.opened = true;
      this.shutdownRequested = false;
      this.opening?.resolve();
      this.opening = null;
      return;
    }

    if (event.type === "pcm_frame") {
      const frame = {
        pcm: Buffer.from(event.pcm16Base64, "base64"),
        sampleRate: event.sampleRate
      };
      for (const listener of this.frameListeners) {
        listener(frame);
      }
      return;
    }

    if (event.type === "segment_result") {
      this.pendingSegmentResult?.resolve({
        pcm16Base64: event.pcm16Base64,
        durationMs: event.durationMs,
        sampleRate: event.sampleRate
      });
      return;
    }

    if (event.type === "closed") {
      this.handleMicClosed();
      return;
    }

    if (event.type === "error") {
      this.handleFailure(new Error(event.message));
      return;
    }
  }

  private handleFailure(error: Error): void {
    this.input.logger.warn("native-audio", "helper-failed", undefined, error);
    this.warming?.reject(error);
    this.warming = null;
    this.opening?.reject(error);
    this.opening = null;
    this.pendingSegmentResult?.reject(error);
    this.pendingSegmentResult = null;
    this.helperReady = false;
    this.opened = false;
    this.activeMode = null;
  }

  private handleMicClosed(): void {
    this.opened = false;
    this.activeMode = null;
  }

  private handleClosed(): void {
    const closeError = this.shutdownRequested
      ? new Error("原生录音 helper 已关闭。")
      : new Error("原生录音 helper 已断开。");
    this.helperReady = false;
    this.opened = false;
    this.warming?.reject(closeError);
    this.warming = null;
    this.opening?.reject(closeError);
    this.opening = null;
    this.activeMode = null;
    this.child = null;
    this.pendingSegmentResult?.reject(closeError);
    this.pendingSegmentResult = null;
  }

  private async sendCommand(command: NativeAudioHelperCommand): Promise<void> {
    if (!this.child) {
      throw new Error("原生录音 helper 未启动。");
    }

    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.runSerialized(async () => {
        await this.requestClose();
      });
    }, this.input.keepAliveMs ?? 5_000);
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) {
      return;
    }

    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private async requestClose(): Promise<void> {
    if (!this.child) {
      return;
    }

    this.opened = false;
    await this.sendCommand({
      command: "close"
    }).catch(() => undefined);
  }

  private async requestShutdown(forceKill: boolean): Promise<void> {
    if (!this.child) {
      return;
    }

    this.shutdownRequested = true;
    await this.sendCommand({
      command: "shutdown"
    }).catch(() => undefined);

    if (forceKill) {
      await delay(50).catch(() => undefined);
      this.child?.kill();
    }
  }

  private runSerialized<T>(task: () => Promise<T>): Promise<T> {
    const next = this.commandChain.then(task, task);
    this.commandChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

function parseEvent(raw: string): NativeAudioHelperEvent {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `native audio helper returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const type = typeof parsed.type === "string" ? parsed.type : "";
  if (type === "ready" || type === "opened" || type === "closed") {
    return {
      type
    };
  }

  if (type === "pcm_frame") {
    return {
      type,
      pcm16Base64: String(parsed.pcm16Base64 ?? ""),
      sampleRate: Number(parsed.sampleRate ?? 16_000)
    };
  }

  if (type === "segment_result") {
    return {
      type,
      pcm16Base64: String(parsed.pcm16Base64 ?? ""),
      durationMs: Number(parsed.durationMs ?? 0),
      sampleRate: Number(parsed.sampleRate ?? 16_000)
    };
  }

  if (type === "error") {
    return {
      type,
      message: String(parsed.message ?? "原生录音 helper 失败")
    };
  }

  throw new Error(`native audio helper returned unsupported event type: ${type || "unknown"}`);
}

function defaultSpawnProcess(helperPath: string): HelperChild {
  return spawn(helperPath, [], {
    stdio: "pipe"
  }) as ChildProcessWithoutNullStreams;
}
