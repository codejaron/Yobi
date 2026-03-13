import test from "node:test";
import assert from "node:assert/strict";
import { shouldAutoStartVoiceSession } from "../services/realtime-voice-lifecycle.js";

test("shouldAutoStartVoiceSession: app launch should not auto-start free mode", () => {
  assert.equal(
    shouldAutoStartVoiceSession({
      enabled: true,
      mode: "free"
    }),
    false
  );
});

test("shouldAutoStartVoiceSession: disabled realtime voice stays off", () => {
  assert.equal(
    shouldAutoStartVoiceSession({
      enabled: false,
      mode: "free"
    }),
    false
  );
});
