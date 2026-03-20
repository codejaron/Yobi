import test from "node:test";
import assert from "node:assert/strict";
import {
  VOICE_ACTIVITY_FRAME_BYTES,
  VOICE_ACTIVITY_FRAME_SAMPLES,
  createSileroVadProcessor,
  createVoiceActivityDetector,
  getSileroVadOptions,
  type SileroVadRuntime,
  type SileroVadRuntimeCallbacks,
  type VoiceActivityDetectorConfig
} from "../services/realtime-voice-vad.js";

const DEFAULT_CONFIG: VoiceActivityDetectorConfig = {
  vadThreshold: 0.5,
  minSpeechMs: 180,
  minSilenceMs: 500
};

function createPcmFrame(sample: number, sampleCount = VOICE_ACTIVITY_FRAME_SAMPLES): Buffer {
  const frame = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    frame.writeInt16LE(sample, index * 2);
  }
  return frame;
}

test("getSileroVadOptions maps Yobi config to Silero frame settings", () => {
  assert.deepEqual(getSileroVadOptions({
    vadThreshold: 0.42,
    minSpeechMs: 180,
    minSilenceMs: 500
  }), {
    model: "v5",
    sampleRate: 16_000,
    frameSamples: 512,
    positiveSpeechThreshold: 0.42,
    negativeSpeechThreshold: 0.27,
    minSpeechFrames: 6,
    redemptionFrames: 16,
    preSpeechPadFrames: 0
  });
});

test("createSileroVadProcessor buffers PCM until a full VAD frame is available", async () => {
  const frames: Float32Array[] = [];
  const processor = await createSileroVadProcessor(DEFAULT_CONFIG, {
    createRuntime: async (callbacks) => ({
      start: () => undefined,
      processAudio: async (frame) => {
        frames.push(frame);
        callbacks.onFrameProcessed(0.61);
        callbacks.onSpeechRealStart();
      },
      reset: () => undefined,
      destroy: () => undefined
    })
  });

  const almostOneFrame = Buffer.alloc(VOICE_ACTIVITY_FRAME_BYTES - 2);
  const firstResult = await processor.processChunk(almostOneFrame);
  assert.deepEqual(firstResult, {
    probability: 0,
    speechStarted: false,
    speechEnded: false,
    speaking: false
  });
  assert.equal(frames.length, 0);

  const finalSample = Buffer.alloc(2);
  finalSample.writeInt16LE(0x7fff, 0);
  const secondResult = await processor.processChunk(finalSample);

  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.length, VOICE_ACTIVITY_FRAME_SAMPLES);
  assert.ok(Math.abs((frames[0]?.[VOICE_ACTIVITY_FRAME_SAMPLES - 1] ?? 0) - 0x7fff / 0x8000) < 1e-6);
  assert.deepEqual(secondResult, {
    probability: 0.61,
    speechStarted: true,
    speechEnded: false,
    speaking: true
  });
});

test("createSileroVadProcessor splits large chunks into ordered Silero frames", async () => {
  const seenFrameStarts: number[] = [];
  const processor = await createSileroVadProcessor(DEFAULT_CONFIG, {
    createRuntime: async (callbacks) => ({
      start: () => undefined,
      processAudio: async (frame) => {
        seenFrameStarts.push(frame[0] ?? 0);
        callbacks.onFrameProcessed(frame[0] > 0 ? 0.85 : 0.12);
        if (seenFrameStarts.length === 1) {
          callbacks.onSpeechRealStart();
        } else {
          callbacks.onSpeechEnd();
        }
      },
      reset: () => undefined,
      destroy: () => undefined
    })
  });

  const twoFrames = Buffer.concat([createPcmFrame(1000), createPcmFrame(-1000)]);
  const result = await processor.processChunk(twoFrames);

  assert.equal(seenFrameStarts.length, 2);
  assert.ok(seenFrameStarts[0] > 0);
  assert.ok(seenFrameStarts[1] < 0);
  assert.deepEqual(result, {
    probability: 0.12,
    speechStarted: true,
    speechEnded: true,
    speaking: false
  });
});

test("createSileroVadProcessor reset clears buffered partial PCM before the next chunk", async () => {
  let processedFrames = 0;
  const processor = await createSileroVadProcessor(DEFAULT_CONFIG, {
    createRuntime: async (_callbacks: SileroVadRuntimeCallbacks): Promise<SileroVadRuntime> => ({
      start: () => undefined,
      processAudio: async () => {
        processedFrames += 1;
      },
      reset: () => undefined,
      destroy: () => undefined
    })
  });

  await processor.processChunk(Buffer.alloc(VOICE_ACTIVITY_FRAME_BYTES / 2));
  processor.reset();
  await processor.processChunk(Buffer.alloc(VOICE_ACTIVITY_FRAME_BYTES / 2));

  assert.equal(processedFrames, 0);
});

test("createVoiceActivityDetector builds a v5-only detector", async () => {
  const detector = await createVoiceActivityDetector({
    config: DEFAULT_CONFIG,
    logger: {
      warn: () => undefined
    } as never,
    createRuntime: async (callbacks) => ({
      start: () => undefined,
      processAudio: async () => {
        callbacks.onFrameProcessed(0.73);
        callbacks.onSpeechRealStart();
      },
      reset: () => undefined,
      destroy: () => undefined
    })
  });

  const result = await detector.processChunk(createPcmFrame(4000));

  assert.equal(result.probability, 0.73);
  assert.equal(result.speechStarted, true);
});

test("createVoiceActivityDetector surfaces v5 init failures", async () => {
  const warnings: string[] = [];
  await assert.rejects(
    () =>
      createVoiceActivityDetector({
        config: {
          vadThreshold: 0.35,
          minSpeechMs: 32,
          minSilenceMs: 32
        },
        logger: {
          info: () => undefined,
          warn: (_module: string, event: string) => {
            warnings.push(event);
          },
          error: () => undefined
        } as never,
        createRuntime: async () => {
          throw new Error("v5 load failed");
        }
      }),
    /v5 load failed/
  );

  assert.deepEqual(warnings, ["silero-v5-init-failed"]);
});

test("createVoiceActivityDetector surfaces v5 runtime failures", async () => {
  const detector = await createVoiceActivityDetector({
    config: DEFAULT_CONFIG,
    logger: {
      warn: () => undefined
    } as never,
    createRuntime: async () => ({
      start: () => undefined,
      processAudio: async () => {
        throw new Error("runtime exploded");
      },
      reset: () => undefined,
      destroy: () => undefined
    })
  });

  await assert.rejects(
    () => detector.processChunk(createPcmFrame(4000)),
    /runtime exploded/
  );
});
