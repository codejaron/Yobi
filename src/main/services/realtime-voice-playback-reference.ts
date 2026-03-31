const EXPECTED_SAMPLE_RATE = 16_000;
// Native mic capture plus speaker / Bluetooth output can push acoustic echo
// well past 200ms even before it reaches this matcher.
const MAX_REFERENCE_AGE_MS = 500;
const MAX_RETAINED_FRAME_COUNT = 96;
const MIN_COMPARABLE_RMS = 0.01;
const ECHO_CORRELATION_THRESHOLD = 0.72;
const ECHO_RESIDUAL_RATIO_THRESHOLD = 0.58;
const MAX_MIC_REFERENCE_RMS_RATIO = 1.8;
const MIN_COMPARABLE_SAMPLES = 80;
const ALIGNMENT_PADDING_MS = 80;
const SEARCH_STEP_SAMPLES = 1;

const ALIGNMENT_PADDING_SAMPLES = Math.floor(
  (EXPECTED_SAMPLE_RATE * ALIGNMENT_PADDING_MS) / 1000
);

interface PlaybackReferenceFrame {
  samples: Float32Array;
  capturedAtMs: number;
}

export interface PlaybackReferenceMatch {
  correlation: number;
  residualRatio: number;
  micRms: number;
  referenceRms: number;
  micToReferenceRmsRatio: number;
  referenceAgeMs: number;
}

interface PushPlaybackReferenceFrameInput {
  pcm: Buffer;
  sampleRate: number;
  capturedAtMs?: number;
}

interface ClassifyMicChunkInput {
  pcm: Buffer;
  sampleRate: number;
  capturedAtMs?: number;
}

interface ReferenceHistory {
  samples: Float32Array;
  sampleCount: number;
  timelineStartMs: number;
}

function decodePcm16Samples(pcm: Buffer): Float32Array {
  const sampleCount = Math.floor(pcm.length / 2);
  const samples = new Float32Array(sampleCount);

  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = pcm.readInt16LE(index * 2) / 0x8000;
  }

  return samples;
}

function calculateReferenceAgeMs(
  referenceStart: number,
  history: ReferenceHistory,
  capturedAtMs: number
): number {
  const unpaddedStart = Math.max(
    0,
    Math.min(history.sampleCount - 1, referenceStart - ALIGNMENT_PADDING_SAMPLES)
  );
  const referenceStartMs =
    history.timelineStartMs + (unpaddedStart / EXPECTED_SAMPLE_RATE) * 1000;
  return Math.max(0, capturedAtMs - referenceStartMs);
}

function calculateWindowMatch(
  micSamples: Float32Array,
  referenceSamples: Float32Array,
  referenceStart: number,
  referenceAgeMs: number
): PlaybackReferenceMatch | null {
  const sampleCount = Math.min(micSamples.length, referenceSamples.length - referenceStart);
  if (sampleCount < MIN_COMPARABLE_SAMPLES) {
    return null;
  }

  let dot = 0;
  let micEnergy = 0;
  let referenceEnergy = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const micSample = micSamples[index] ?? 0;
    const referenceSample = referenceSamples[referenceStart + index] ?? 0;
    dot += micSample * referenceSample;
    micEnergy += micSample * micSample;
    referenceEnergy += referenceSample * referenceSample;
  }

  if (micEnergy <= 0 || referenceEnergy <= 0) {
    return null;
  }

  const micRms = Math.sqrt(micEnergy / sampleCount);
  const referenceRms = Math.sqrt(referenceEnergy / sampleCount);
  if (micRms < MIN_COMPARABLE_RMS || referenceRms < MIN_COMPARABLE_RMS) {
    return null;
  }

  const scale = dot / referenceEnergy;
  let residualEnergy = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const micSample = micSamples[index] ?? 0;
    const referenceSample = referenceSamples[referenceStart + index] ?? 0;
    const residual = micSample - referenceSample * scale;
    residualEnergy += residual * residual;
  }

  return {
    correlation: dot / Math.sqrt(micEnergy * referenceEnergy),
    residualRatio: Math.sqrt(residualEnergy / micEnergy),
    micRms,
    referenceRms,
    micToReferenceRmsRatio: micRms / referenceRms,
    referenceAgeMs
  };
}

export class PlaybackReferenceTracker {
  private frames: PlaybackReferenceFrame[] = [];

  pushFrame(input: PushPlaybackReferenceFrameInput): void {
    if (input.sampleRate !== EXPECTED_SAMPLE_RATE || input.pcm.length < 2) {
      return;
    }

    const capturedAtMs = input.capturedAtMs ?? Date.now();
    this.frames.push({
      samples: decodePcm16Samples(input.pcm),
      capturedAtMs
    });
    this.prune(capturedAtMs);
  }

  clear(): void {
    this.frames = [];
  }

  classifyMicChunk(input: ClassifyMicChunkInput): {
    echoLikely: boolean;
    match: PlaybackReferenceMatch | null;
  } {
    if (input.sampleRate !== EXPECTED_SAMPLE_RATE || input.pcm.length < 2) {
      return {
        echoLikely: false,
        match: null
      };
    }

    const capturedAtMs = input.capturedAtMs ?? Date.now();
    this.prune(capturedAtMs);
    const micSamples = decodePcm16Samples(input.pcm);
    const history = this.buildReferenceHistory();
    if (!history) {
      return {
        echoLikely: false,
        match: null
      };
    }

    let bestMatch: PlaybackReferenceMatch | null = null;
    const lastReferenceStart = history.samples.length - micSamples.length;
    if (lastReferenceStart < 0) {
      return {
        echoLikely: false,
        match: null
      };
    }

    for (
      let referenceStart = 0;
      referenceStart <= lastReferenceStart;
      referenceStart += SEARCH_STEP_SAMPLES
    ) {
      const match = calculateWindowMatch(
        micSamples,
        history.samples,
        referenceStart,
        calculateReferenceAgeMs(referenceStart, history, capturedAtMs)
      );
      if (!match) {
        continue;
      }

      if (!bestMatch || match.correlation > bestMatch.correlation) {
        bestMatch = match;
      }
    }

    if (!bestMatch) {
      return {
        echoLikely: false,
        match: null
      };
    }

    const echoLikely =
      bestMatch.correlation >= ECHO_CORRELATION_THRESHOLD &&
      bestMatch.residualRatio <= ECHO_RESIDUAL_RATIO_THRESHOLD &&
      bestMatch.micToReferenceRmsRatio <= MAX_MIC_REFERENCE_RMS_RATIO;

    return {
      echoLikely,
      match: bestMatch
    };
  }

  private buildReferenceHistory(): ReferenceHistory | null {
    if (this.frames.length === 0) {
      return null;
    }

    const sampleCount = this.frames.reduce((total, frame) => total + frame.samples.length, 0);
    if (sampleCount < MIN_COMPARABLE_SAMPLES) {
      return null;
    }

    const samples = new Float32Array(sampleCount + ALIGNMENT_PADDING_SAMPLES * 2);
    let writeOffset = ALIGNMENT_PADDING_SAMPLES;
    for (const frame of this.frames) {
      samples.set(frame.samples, writeOffset);
      writeOffset += frame.samples.length;
    }

    const firstFrame = this.frames[0];
    const timelineStartMs =
      firstFrame.capturedAtMs - (firstFrame.samples.length / EXPECTED_SAMPLE_RATE) * 1000;

    return {
      samples,
      sampleCount,
      timelineStartMs
    };
  }

  private prune(nowMs: number): void {
    const minCapturedAtMs = nowMs - MAX_REFERENCE_AGE_MS;
    this.frames = this.frames.filter((frame) => frame.capturedAtMs >= minCapturedAtMs);
    if (this.frames.length > MAX_RETAINED_FRAME_COUNT) {
      this.frames = this.frames.slice(this.frames.length - MAX_RETAINED_FRAME_COUNT);
    }
  }
}
