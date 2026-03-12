import test from "node:test";
import assert from "node:assert/strict";
import {
  createVoiceSessionState,
  reduceVoiceSessionState
} from "../services/realtime-voice-state.js";

test("reduceVoiceSessionState: free mode runs through listening to speaking", () => {
  let state = createVoiceSessionState({
    sessionId: "session-1",
    mode: "free",
    target: {
      resourceId: "resource-1",
      threadId: "thread-1"
    }
  });

  state = reduceVoiceSessionState(state, { type: "session-started" });
  assert.equal(state.phase, "listening");

  state = reduceVoiceSessionState(state, { type: "speech-started" });
  assert.equal(state.phase, "user-speaking");

  state = reduceVoiceSessionState(state, { type: "speech-ended" });
  assert.equal(state.phase, "transcribing");

  state = reduceVoiceSessionState(state, { type: "assistant-thinking-started" });
  assert.equal(state.phase, "assistant-thinking");

  state = reduceVoiceSessionState(state, { type: "assistant-playback-started" });
  assert.equal(state.phase, "assistant-speaking");
});

test("reduceVoiceSessionState: barge-in while assistant is speaking transitions to interrupted", () => {
  let state = createVoiceSessionState({
    sessionId: "session-1",
    mode: "free",
    target: {
      resourceId: "resource-1",
      threadId: "thread-1"
    }
  });

  state = reduceVoiceSessionState(state, { type: "session-started" });
  state = reduceVoiceSessionState(state, { type: "assistant-thinking-started" });
  state = reduceVoiceSessionState(state, { type: "assistant-playback-started" });

  const interrupted = reduceVoiceSessionState(state, {
    type: "barge-in-detected",
    reason: "vad"
  });

  assert.equal(interrupted.phase, "interrupted");
  assert.equal(interrupted.lastInterruptReason, "vad");
});

test("reduceVoiceSessionState: stop returns session to idle", () => {
  let state = createVoiceSessionState({
    sessionId: "session-1",
    mode: "ptt",
    target: {
      resourceId: "resource-1",
      threadId: "thread-1"
    }
  });

  state = reduceVoiceSessionState(state, { type: "session-started" });
  state = reduceVoiceSessionState(state, { type: "speech-started" });
  state = reduceVoiceSessionState(state, { type: "session-stopped" });

  assert.equal(state.phase, "idle");
});
