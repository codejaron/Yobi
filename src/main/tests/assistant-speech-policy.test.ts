import test from "node:test";
import assert from "node:assert/strict";
import { resolveAssistantSpeechRoute } from "../services/assistant-speech-policy.js";

test("resolveAssistantSpeechRoute: no pet and no realtime session should stay silent", () => {
  assert.equal(
    resolveAssistantSpeechRoute({
      speechReplyEnabled: true,
      petOnline: false,
      unifiedRealtimeVoice: false,
      realtimeSessionActive: false
    }),
    "none"
  );
});

test("resolveAssistantSpeechRoute: active realtime session can speak even without pet", () => {
  assert.equal(
    resolveAssistantSpeechRoute({
      speechReplyEnabled: false,
      petOnline: false,
      unifiedRealtimeVoice: false,
      realtimeSessionActive: true
    }),
    "realtime"
  );
});

test("resolveAssistantSpeechRoute: non-unified mode with online pet uses pet audio", () => {
  assert.equal(
    resolveAssistantSpeechRoute({
      speechReplyEnabled: true,
      petOnline: true,
      unifiedRealtimeVoice: false,
      realtimeSessionActive: false
    }),
    "pet"
  );
});

test("resolveAssistantSpeechRoute: unified mode with online pet uses realtime host audio", () => {
  assert.equal(
    resolveAssistantSpeechRoute({
      speechReplyEnabled: true,
      petOnline: true,
      unifiedRealtimeVoice: true,
      realtimeSessionActive: false
    }),
    "realtime"
  );
});
