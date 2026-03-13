import test from "node:test";
import assert from "node:assert/strict";
import { buildInterruptedAssistantCommit } from "../services/realtime-voice-persistence.js";

test("buildInterruptedAssistantCommit: keeps only the played assistant prefix", () => {
  const commit = buildInterruptedAssistantCommit({
    fullText: "你好呀，我们继续聊今天的安排。",
    playedText: "你好呀，",
    sessionId: "voice-session-1",
    mode: "free",
    asrProvider: "sensevoice-local",
    ttsProvider: "edge"
  });

  assert.equal(commit.text, "你好呀，");
  assert.equal(commit.metadata.voice?.interrupted, true);
  assert.equal(commit.metadata.voice?.playedTextLength, "你好呀，".length);
  assert.equal(commit.metadata.voice?.sessionId, "voice-session-1");
});

test("buildInterruptedAssistantCommit: falls back to visible full text when played text is empty", () => {
  const commit = buildInterruptedAssistantCommit({
    fullText:
      "<think>internal</think>你好。<signals user_mood=\"neutral\" engagement=\"0.5\" trust_delta=\"0\" friction=\"false\" curiosity_trigger=\"false\" />",
    playedText: "",
    sessionId: "voice-session-1",
    mode: "free",
    asrProvider: "alibaba",
    ttsProvider: "alibaba"
  });

  assert.equal(commit.text, "你好。");
  assert.equal(commit.metadata.voice?.interrupted, true);
  assert.equal(commit.metadata.voice?.asrProvider, "alibaba");
  assert.equal(commit.metadata.voice?.ttsProvider, "alibaba");
});
