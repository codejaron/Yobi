import type { VoiceTranscriptionResult } from "@shared/types";
import type { StreamingAsrSession } from "./voice-router";
import { parseSenseVoiceRichText } from "./sensevoice-rich-text";
import { SenseVoiceSidecarClient } from "./sensevoice-sidecar-client";

function emptyResult(): VoiceTranscriptionResult {
  return {
    text: "",
    metadata: null
  };
}

export class SenseVoiceLocalService {
  private readonly client = new SenseVoiceSidecarClient();
  private modelPath: string | null = null;
  private loadingPromise: Promise<void> | null = null;
  private loadError: Error | null = null;
  private ready = false;
  private generation = 0;

  configureModel(modelPath: string | null): void {
    if (!modelPath) {
      this.reset();
      return;
    }

    if (this.modelPath === modelPath && (this.ready || this.loadingPromise)) {
      return;
    }

    this.reset();
    this.modelPath = modelPath;
    const generation = ++this.generation;

    this.loadingPromise = this.client.loadModel(modelPath)
      .then(() => {
        if (this.generation === generation) {
          this.ready = true;
          this.loadError = null;
        }
      })
      .catch((error) => {
        if (this.generation === generation) {
          this.ready = false;
          this.loadError = error instanceof Error ? error : new Error(String(error));
          this.client.dispose();
        }
      })
      .finally(() => {
        if (this.generation === generation) {
          this.loadingPromise = null;
        }
      });
  }

  reset(): void {
    this.generation += 1;
    this.ready = false;
    this.modelPath = null;
    this.loadError = null;
    this.loadingPromise = null;
    this.client.dispose();
  }

  isReady(): boolean {
    return this.ready && this.loadError === null;
  }

  getLoadErrorMessage(): string | null {
    return this.loadError?.message ?? null;
  }

  async transcribe(input: {
    pcm: Buffer;
    sampleRate: number;
  }): Promise<VoiceTranscriptionResult> {
    await this.waitUntilReady();
    const result = await this.client.transcribe(input);
    return this.parseResult(result.rawText);
  }

  createStreamingSession(input: {
    sampleRate: number;
    onPartial?: (text: string) => void;
  }): StreamingAsrSession {
    if (this.loadError) {
      throw new Error(`本地 SenseVoice 初始化失败：${this.loadError.message}`);
    }

    if (!this.ready && !this.loadingPromise) {
      throw new Error("本地 SenseVoice 模型未就绪，请先下载模型并保存设置。");
    }

    let closed = false;
    let closing = false;
    let transcribing = false;
    let scheduled: NodeJS.Timeout | null = null;
    let inFlightPartial: Promise<void> | null = null;
    let activePartialRunId = 0;
    let latestText = "";
    const openPromise = this.waitUntilReady()
      .then(() => this.client.openStream({
        sampleRate: input.sampleRate
      }))
      .catch((error) => {
        throw error;
      });
    void openPromise.catch(() => undefined);

    const runPartial = (): Promise<void> => {
      if (closed || closing || transcribing) {
        return Promise.resolve();
      }

      const runId = activePartialRunId + 1;
      activePartialRunId = runId;
      const partialPromise = (async (): Promise<void> => {
        scheduled = null;
        transcribing = true;
        try {
          const { streamId } = await openPromise;
          const partial = this.parseResult((await this.client.flushStream(streamId)).rawText);
          if (!closed && !closing && partial.text && partial.text !== latestText) {
            latestText = partial.text;
            input.onPartial?.(partial.text);
          }
        } finally {
          transcribing = false;
          if (activePartialRunId === runId) {
            inFlightPartial = null;
          }
        }
      })();

      inFlightPartial = partialPromise;
      return partialPromise;
    };

    const schedulePartial = (): void => {
      if (closed || transcribing) {
        return;
      }

      if (scheduled || closing) {
        return;
      }

      scheduled = setTimeout(() => {
        void runPartial();
      }, 360);
      scheduled.unref?.();
    };

    return {
      pushPcm: async (chunk: Buffer) => {
        if (closed || chunk.length === 0) {
          return;
        }

        const { streamId } = await openPromise;
        await this.client.pushStreamChunk({
          streamId,
          pcm: Buffer.from(chunk)
        });
        schedulePartial();
      },
      flush: async () => {
        if (scheduled) {
          clearTimeout(scheduled);
          scheduled = null;
        }

        if (closed) {
          return emptyResult();
        }

        closing = true;
        await inFlightPartial?.catch(() => undefined);

        const { streamId } = await openPromise;
        const result = this.parseResult((await this.client.closeStream(streamId)).rawText);
        latestText = result.text;
        closed = true;
        closing = false;
        return result;
      },
      abort: async () => {
        closing = true;
        closed = true;
        if (scheduled) {
          clearTimeout(scheduled);
          scheduled = null;
        }

        await inFlightPartial?.catch(() => undefined);
        const stream = await openPromise.catch(() => null);
        if (stream?.streamId) {
          await this.client.abortStream(stream.streamId).catch(() => undefined);
        }
      }
    };
  }

  private parseResult(rawText: string): VoiceTranscriptionResult {
    const parsed = parseSenseVoiceRichText(rawText);
    return {
      text: parsed.text,
      metadata: parsed.metadata.rawTags.length > 0 || parsed.text
        ? parsed.metadata
        : null
    };
  }

  private async waitUntilReady(): Promise<void> {
    if (this.loadingPromise) {
      await this.loadingPromise;
    }

    if (this.loadError) {
      throw new Error(`本地 SenseVoice 初始化失败：${this.loadError.message}`);
    }

    if (!this.ready || !this.modelPath) {
      throw new Error("本地 SenseVoice 模型未就绪，请先下载模型并保存设置。");
    }
  }
}
