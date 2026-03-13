import test from "node:test";
import assert from "node:assert/strict";
import { parseSenseVoiceRichText } from "../services/sensevoice-rich-text.js";

test("parseSenseVoiceRichText: extracts text and normalized metadata from SenseVoice tags", () => {
  const parsed = parseSenseVoiceRichText("<|zh|><|HAPPY|><|Speech|><|withitn|>今天天气很好");

  assert.equal(parsed.text, "今天天气很好");
  assert.deepEqual(parsed.metadata, {
    language: "zh",
    emotion: "happy",
    event: "speech",
    rawTags: ["zh", "HAPPY", "Speech", "withitn"]
  });
});

test("parseSenseVoiceRichText: strips tags even when metadata cannot be classified", () => {
  const parsed = parseSenseVoiceRichText("<|custom|><|mystery|>hello world");

  assert.equal(parsed.text, "hello world");
  assert.deepEqual(parsed.metadata, {
    language: null,
    emotion: null,
    event: null,
    rawTags: ["custom", "mystery"]
  });
});
