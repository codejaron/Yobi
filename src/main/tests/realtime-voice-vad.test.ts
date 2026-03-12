import test from "node:test";
import assert from "node:assert/strict";
import { estimateSpeechProbabilityFromRms } from "../services/realtime-voice-vad.js";

test("estimateSpeechProbabilityFromRms: background noise stays below trigger threshold", () => {
  assert.equal(estimateSpeechProbabilityFromRms(0), 0);
  assert.ok(estimateSpeechProbabilityFromRms(0.003) < 0.2);
  assert.ok(estimateSpeechProbabilityFromRms(0.008) < 0.3);
});

test("estimateSpeechProbabilityFromRms: normal speech maps above default VAD threshold", () => {
  assert.ok(estimateSpeechProbabilityFromRms(0.02) > 0.35);
  assert.ok(estimateSpeechProbabilityFromRms(0.03) > 0.55);
  assert.ok(estimateSpeechProbabilityFromRms(0.05) >= 0.95);
});
