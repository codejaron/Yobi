import test from "node:test";
import assert from "node:assert/strict";
import { PlaybackReferenceTracker } from "../services/realtime-voice-playback-reference.js";

function makeSineChunk(
  frequencyHz: number,
  amplitude = 12_000,
  sampleRate = 16_000,
  sampleCount = 320
): Buffer {
  const pcm = Buffer.alloc(sampleCount * 2);

  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.round(
      Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate) * amplitude
    );
    pcm.writeInt16LE(value, index * 2);
  }

  return pcm;
}

function makeNoiseChunk(seed = 7, amplitude = 14_000, sampleCount = 320): Buffer {
  const pcm = Buffer.alloc(sampleCount * 2);
  let state = seed >>> 0;

  for (let index = 0; index < sampleCount; index += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const normalized = (state / 0xffffffff) * 2 - 1;
    const value = Math.round(normalized * amplitude);
    pcm.writeInt16LE(value, index * 2);
  }

  return pcm;
}

function mixChunks(left: Buffer, right: Buffer, leftGain: number, rightGain: number): Buffer {
  const byteLength = Math.min(left.length, right.length);
  const mixed = Buffer.alloc(byteLength);

  for (let offset = 0; offset < byteLength; offset += 2) {
    const leftSample = left.readInt16LE(offset);
    const rightSample = right.readInt16LE(offset);
    const summed = Math.round(leftSample * leftGain + rightSample * rightGain);
    const clamped = Math.max(-0x8000, Math.min(0x7fff, summed));
    mixed.writeInt16LE(clamped, offset);
  }

  return mixed;
}

function delayAndScaleChunk(
  input: Buffer,
  delaySamples: number,
  gain: number,
  noiseAmplitude = 0
): Buffer {
  const sampleCount = Math.floor(input.length / 2);
  const delayed = Buffer.alloc(input.length);
  let state = 17 >>> 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const sourceIndex = index - delaySamples;
    const sourceSample = sourceIndex >= 0 ? input.readInt16LE(sourceIndex * 2) : 0;
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    const noise = noiseAmplitude > 0 ? (((state / 0xffffffff) * 2 - 1) * noiseAmplitude) : 0;
    const value = Math.round(sourceSample * gain + noise);
    delayed.writeInt16LE(Math.max(-0x8000, Math.min(0x7fff, value)), index * 2);
  }

  return delayed;
}

function sliceFrame(input: Buffer, frameIndex: number, frameSamples = 320): Buffer {
  const start = frameIndex * frameSamples * 2;
  return input.subarray(start, start + frameSamples * 2);
}

test("playback reference tracker marks matching playback as echo", () => {
  const tracker = new PlaybackReferenceTracker();
  const reference = makeSineChunk(440);

  tracker.pushFrame({
    pcm: reference,
    sampleRate: 16_000,
    capturedAtMs: 1_000
  });

  const decision = tracker.classifyMicChunk({
    pcm: reference,
    sampleRate: 16_000,
    capturedAtMs: 1_010
  });

  assert.equal(decision.echoLikely, true);
  assert.ok(decision.match);
  assert.ok((decision.match?.correlation ?? 0) > 0.9);
});

test("playback reference tracker ignores stale playback frames", () => {
  const tracker = new PlaybackReferenceTracker();
  const reference = makeSineChunk(440);

  tracker.pushFrame({
    pcm: reference,
    sampleRate: 16_000,
    capturedAtMs: 1_000
  });

  const decision = tracker.classifyMicChunk({
    pcm: reference,
    sampleRate: 16_000,
    capturedAtMs: 1_600
  });

  assert.equal(decision.echoLikely, false);
  assert.equal(decision.match, null);
});

test("playback reference tracker preserves a distinct user barge-in over playback", () => {
  const tracker = new PlaybackReferenceTracker();
  const reference = makeSineChunk(440, 8_000);
  const userSpeech = makeSineChunk(1_260, 16_000);
  const mixedMic = mixChunks(reference, userSpeech, 0.55, 1);

  tracker.pushFrame({
    pcm: reference,
    sampleRate: 16_000,
    capturedAtMs: 2_000
  });

  const decision = tracker.classifyMicChunk({
    pcm: mixedMic,
    sampleRate: 16_000,
    capturedAtMs: 2_015
  });

  assert.equal(decision.echoLikely, false);
});

test("playback reference tracker still catches delayed acoustic echo", () => {
  const tracker = new PlaybackReferenceTracker();
  const reference = makeNoiseChunk(11, 11_000);
  const delayedEcho = delayAndScaleChunk(reference, 42, 0.58, 220);

  tracker.pushFrame({
    pcm: reference,
    sampleRate: 16_000,
    capturedAtMs: 3_000
  });

  const decision = tracker.classifyMicChunk({
    pcm: delayedEcho,
    sampleRate: 16_000,
    capturedAtMs: 3_018
  });

  assert.equal(decision.echoLikely, true);
  assert.ok(decision.match);
});

test("playback reference tracker still catches longer device-latency echo", () => {
  const tracker = new PlaybackReferenceTracker();
  const totalFrames = 30;
  const delayFrames = 12;
  const reference = makeNoiseChunk(19, 11_000, 320 * totalFrames);
  const delayedEcho = delayAndScaleChunk(reference, 320 * delayFrames, 0.58, 220);
  let decisions = 0;

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
    tracker.pushFrame({
      pcm: sliceFrame(reference, frameIndex),
      sampleRate: 16_000,
      capturedAtMs: 5_000 + frameIndex * 20
    });

    const micFrameIndex = frameIndex + delayFrames;
    if (micFrameIndex >= totalFrames) {
      continue;
    }

    const decision = tracker.classifyMicChunk({
      pcm: sliceFrame(delayedEcho, micFrameIndex),
      sampleRate: 16_000,
      capturedAtMs: 5_000 + micFrameIndex * 20
    });

    decisions += 1;
    assert.equal(decision.echoLikely, true);
    assert.ok(decision.match);
  }

  assert.ok(decisions > 0);
});
