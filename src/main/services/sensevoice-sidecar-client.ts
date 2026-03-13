import { resolveSenseVoiceBackendPath, resolveSenseVoiceWorkerPath } from "./sensevoice-runtime-paths";

interface WorkerMessage {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface SidecarRawResult {
  rawText: string;
}

export class SenseVoiceSidecarClient {
  private worker: any = null;
  private ready = false;
  private message = "disabled";
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  async init(): Promise<void> {
    if (this.ready) {
      return;
    }

    if (!process.versions.electron) {
      this.message = "sensevoice-sidecar-unavailable";
      throw new Error("SenseVoice sidecar 仅在 Electron 运行时可用。");
    }

    const electron = await import("electron");
    const workerPath = await resolveSenseVoiceWorkerPath();
    const child = electron.utilityProcess.fork(workerPath, [], {
      serviceName: "yobi-sensevoice-sidecar"
    });

    child.on("message", (message: WorkerMessage) => {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      if (message.ok) {
        pending.resolve(message.result);
        return;
      }

      pending.reject(new Error(message.error || "sensevoice-sidecar-call-failed"));
    });

    child.once?.("exit", () => {
      this.worker = null;
      this.ready = false;
      this.message = "sensevoice-sidecar-exited";
      for (const pending of this.pending.values()) {
        pending.reject(new Error("sensevoice-sidecar-exited"));
      }
      this.pending.clear();
    });

    this.worker = child;
    this.ready = true;
    this.message = "ready";
  }

  async loadModel(modelPath: string): Promise<void> {
    const backendPath = await resolveSenseVoiceBackendPath();
    await this.call("load-model", {
      backendPath,
      modelPath
    });
  }

  async health(): Promise<{
    ready: boolean;
    message: string;
  }> {
    try {
      const result = await this.call("health", {});
      const ready =
        typeof result === "object" &&
        result !== null &&
        "ready" in result &&
        (result as { ready?: unknown }).ready === true;
      const message =
        typeof result === "object" &&
        result !== null &&
        "message" in result &&
        typeof (result as { message?: unknown }).message === "string"
          ? String((result as { message?: unknown }).message)
          : this.message;
      return {
        ready,
        message
      };
    } catch (error) {
      return {
        ready: false,
        message: error instanceof Error ? error.message : "sensevoice-sidecar-health-failed"
      };
    }
  }

  async transcribe(input: {
    pcm: Buffer;
    sampleRate: number;
  }): Promise<SidecarRawResult> {
    return this.call("transcribe", {
      pcm16Base64: input.pcm.toString("base64"),
      sampleRate: input.sampleRate
    }) as Promise<SidecarRawResult>;
  }

  async openStream(input: {
    sampleRate: number;
  }): Promise<{ streamId: string }> {
    return this.call("stream-open", {
      sampleRate: input.sampleRate
    }) as Promise<{ streamId: string }>;
  }

  async pushStreamChunk(input: {
    streamId: string;
    pcm: Buffer;
  }): Promise<void> {
    await this.call("stream-chunk", {
      streamId: input.streamId,
      pcm16Base64: input.pcm.toString("base64")
    });
  }

  async flushStream(streamId: string): Promise<SidecarRawResult> {
    return this.call("stream-flush", {
      streamId
    }) as Promise<SidecarRawResult>;
  }

  async closeStream(streamId: string): Promise<SidecarRawResult> {
    return this.call("stream-close", {
      streamId
    }) as Promise<SidecarRawResult>;
  }

  async abortStream(streamId: string): Promise<void> {
    await this.call("stream-abort", {
      streamId
    });
  }

  dispose(): void {
    const worker = this.worker;
    this.worker = null;
    this.ready = false;
    this.message = "disposed";
    for (const pending of this.pending.values()) {
      pending.reject(new Error("sensevoice-sidecar-disposed"));
    }
    this.pending.clear();
    if (worker?.kill) {
      try {
        worker.kill();
      } catch {
        // Ignore worker shutdown failures.
      }
    }
  }

  private async call(type: string, payload: Record<string, unknown>): Promise<unknown> {
    await this.init();
    if (!this.worker || !this.ready) {
      throw new Error("sensevoice-sidecar-unavailable");
    }

    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({
        id,
        type,
        ...payload
      });
    });
  }
}
