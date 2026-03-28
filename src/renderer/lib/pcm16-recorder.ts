interface Pcm16Capture {
  pcm16Base64: string;
  durationMs: number;
  sampleRate: number;
}

export async function warmupPcm16Recorder(): Promise<void> {
  await window.companion.warmupAudioCapture();
}

function isNativeCaptureUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /unsupported|不支持/i.test(message);
}

function mergeChunks(chunks: Float32Array[]): Float32Array {
  if (chunks.length === 0) {
    return new Float32Array(0);
  }

  const totalLength = chunks.reduce((sum, item) => sum + item.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

function downsampleToRate(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (input.length === 0 || inputRate === outputRate) {
    return input;
  }

  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);

  let outputIndex = 0;
  let inputOffset = 0;

  while (outputIndex < outputLength) {
    const nextOffset = Math.min(input.length, Math.floor((outputIndex + 1) * ratio));
    let total = 0;
    let count = 0;

    for (let index = inputOffset; index < nextOffset; index += 1) {
      total += input[index] ?? 0;
      count += 1;
    }

    output[outputIndex] = count > 0 ? total / count : 0;
    outputIndex += 1;
    inputOffset = nextOffset;
  }

  return output;
}

function floatToInt16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);

  for (let index = 0; index < input.length; index += 1) {
    const value = Math.max(-1, Math.min(1, input[index] ?? 0));
    output[index] = value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff);
  }

  return output;
}

function uint8ToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return "";
  }

  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...slice);
  }

  return btoa(binary);
}

class BrowserPcm16Recorder {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private inputSampleRate = 44_100;
  private startedAt = 0;

  isRecording(): boolean {
    return this.stream !== null;
  }

  async start(): Promise<void> {
    if (this.stream) {
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true
      }
    });

    const audioContext = new AudioContext();
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    const sourceNode = audioContext.createMediaStreamSource(stream);
    const processorNode = audioContext.createScriptProcessor(4096, 1, 1);

    this.chunks = [];
    this.inputSampleRate = audioContext.sampleRate;
    this.startedAt = Date.now();

    processorNode.onaudioprocess = (event) => {
      const channel = event.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(channel));
    };

    sourceNode.connect(processorNode);
    processorNode.connect(audioContext.destination);

    this.stream = stream;
    this.audioContext = audioContext;
    this.sourceNode = sourceNode;
    this.processorNode = processorNode;
  }

  async stop(outputRate = 16_000): Promise<Pcm16Capture> {
    const { chunks, sampleRate, elapsedMs } = await this.teardown(true);
    const merged = mergeChunks(chunks);
    const downsampled = downsampleToRate(merged, sampleRate, outputRate);
    const pcm16 = floatToInt16(downsampled);
    const pcm16Base64 = uint8ToBase64(new Uint8Array(pcm16.buffer));

    const durationMs =
      pcm16.length > 0
        ? Math.round((pcm16.length / outputRate) * 1000)
        : Math.max(0, elapsedMs);

    return {
      pcm16Base64,
      durationMs,
      sampleRate: outputRate
    };
  }

  async cancel(): Promise<void> {
    await this.teardown(false);
  }

  private async teardown(preserveChunks: boolean): Promise<{
    chunks: Float32Array[];
    sampleRate: number;
    elapsedMs: number;
  }> {
    const sampleRate = this.inputSampleRate;
    const elapsedMs = this.startedAt > 0 ? Date.now() - this.startedAt : 0;
    const chunks = preserveChunks ? this.chunks.slice() : [];

    if (this.processorNode) {
      this.processorNode.onaudioprocess = null;
      try {
        this.processorNode.disconnect();
      } catch {}
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {}
    }

    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
    }

    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {}
    }

    this.stream = null;
    this.audioContext = null;
    this.sourceNode = null;
    this.processorNode = null;
    this.chunks = [];
    this.startedAt = 0;

    return {
      chunks,
      sampleRate,
      elapsedMs
    };
  }
}

class NativeSegmentRecorder {
  private recording = false;
  private startPromise: Promise<void> | null = null;

  isRecording(): boolean {
    return this.recording || this.startPromise !== null;
  }

  async start(): Promise<void> {
    if (this.recording) {
      return;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    const promise = window.companion
      .startAudioCaptureSegment()
      .then(() => {
        this.recording = true;
      })
      .finally(() => {
        this.startPromise = null;
      });

    this.startPromise = promise;
    return promise;
  }

  async stop(_outputRate = 16_000): Promise<Pcm16Capture> {
    await this.startPromise?.catch(() => undefined);
    if (!this.recording) {
      return {
        pcm16Base64: "",
        durationMs: 0,
        sampleRate: 16_000
      };
    }

    const captured = await window.companion.stopAudioCaptureSegment();
    this.recording = false;
    return captured;
  }

  async cancel(): Promise<void> {
    await this.startPromise?.catch(() => undefined);
    if (!this.recording) {
      return;
    }

    await window.companion.cancelAudioCaptureSegment();
    this.recording = false;
  }
}

export class Pcm16Recorder {
  private backend: BrowserPcm16Recorder | NativeSegmentRecorder | null = null;
  private pendingBackend: BrowserPcm16Recorder | NativeSegmentRecorder | null = null;
  private startPromise: Promise<void> | null = null;

  isRecording(): boolean {
    return this.backend?.isRecording() ?? this.pendingBackend?.isRecording() ?? false;
  }

  async start(): Promise<void> {
    if (this.backend) {
      return;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    const promise = (async () => {
      try {
        const nativeRecorder = new NativeSegmentRecorder();
        this.pendingBackend = nativeRecorder;
        await nativeRecorder.start();
        this.backend = nativeRecorder;
        return;
      } catch (error) {
        if (!isNativeCaptureUnsupported(error)) {
          throw error;
        }
      }

      const browserRecorder = new BrowserPcm16Recorder();
      this.pendingBackend = browserRecorder;
      await browserRecorder.start();
      this.backend = browserRecorder;
    })().finally(() => {
      this.startPromise = null;
      this.pendingBackend = null;
    });

    this.startPromise = promise;
    return promise;
  }

  async stop(outputRate = 16_000): Promise<Pcm16Capture> {
    await this.startPromise?.catch(() => undefined);
    const backend = this.backend;
    this.backend = null;
    if (!backend) {
      return {
        pcm16Base64: "",
        durationMs: 0,
        sampleRate: outputRate
      };
    }

    return backend.stop(outputRate);
  }

  async cancel(): Promise<void> {
    await this.startPromise?.catch(() => undefined);
    const backend = this.backend;
    this.backend = null;
    await backend?.cancel();
  }
}
