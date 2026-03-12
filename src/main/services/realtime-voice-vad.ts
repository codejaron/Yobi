function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, value));
}

// Empirical fallback mapping for cases where the Silero VAD model is absent.
// Typical AGC-processed speech RMS lands around 0.02-0.05, while room noise is usually below 0.008.
export function estimateSpeechProbabilityFromRms(rms: number): number {
  const value = clampNumber(rms, 0, 1);
  if (value <= 0.004) {
    return 0;
  }

  if (value >= 0.04) {
    return 1;
  }

  return clampNumber((value - 0.004) / 0.036, 0, 1);
}
