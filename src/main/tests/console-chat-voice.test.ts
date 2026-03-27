import test from "node:test";
import assert from "node:assert/strict";
import {
  getRealtimeVoiceToggleButtonState,
  shouldDisableConsoleMicButton
} from "@shared/console-chat-voice";

test("shouldDisableConsoleMicButton: idle mic stays clickable without pre-check gating", () => {
  assert.equal(
    shouldDisableConsoleMicButton({
      pendingApproval: false,
      recording: false,
      transcribing: false,
      busy: false
    }),
    false
  );
});

test("shouldDisableConsoleMicButton: approval blocks mic unless already recording", () => {
  assert.equal(
    shouldDisableConsoleMicButton({
      pendingApproval: true,
      recording: false,
      transcribing: false,
      busy: false
    }),
    true
  );

  assert.equal(
    shouldDisableConsoleMicButton({
      pendingApproval: true,
      recording: true,
      transcribing: false,
      busy: false
    }),
    false
  );
});

test("shouldDisableConsoleMicButton: busy and transcribing states still block mic", () => {
  assert.equal(
    shouldDisableConsoleMicButton({
      pendingApproval: false,
      recording: false,
      transcribing: true,
      busy: false
    }),
    true
  );

  assert.equal(
    shouldDisableConsoleMicButton({
      pendingApproval: false,
      recording: false,
      transcribing: false,
      busy: true
    }),
    true
  );
});

test("getRealtimeVoiceToggleButtonState: idle realtime voice button stays clickable", () => {
  assert.deepEqual(
    getRealtimeVoiceToggleButtonState({
      sessionActive: false,
      starting: false
    }),
    {
      label: "启动实时语音",
      disabled: false,
      loading: false
    }
  );
});

test("getRealtimeVoiceToggleButtonState: startup shows connecting feedback and blocks repeat clicks", () => {
  assert.deepEqual(
    getRealtimeVoiceToggleButtonState({
      sessionActive: false,
      starting: true
    }),
    {
      label: "连接中…",
      disabled: true,
      loading: true
    }
  );
});

test("getRealtimeVoiceToggleButtonState: active realtime voice button shows stop action", () => {
  assert.deepEqual(
    getRealtimeVoiceToggleButtonState({
      sessionActive: true,
      starting: false
    }),
    {
      label: "停止实时语音",
      disabled: false,
      loading: false
    }
  );
});
