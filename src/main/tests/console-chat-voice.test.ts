import test from "node:test";
import assert from "node:assert/strict";
import {
  toggleCompanionModeWithVoiceSessionSync
} from "@shared/console-chat-voice";
import type { CompanionModeState, VoiceSessionState } from "@shared/types";

function createCompanionModeState(active: boolean): CompanionModeState {
  return {
    active,
    availability: "ready",
    reason: null,
    lastSampleAt: null,
    lastProactiveAt: null,
    frontWindow: null
  };
}

function createVoiceSessionState(
  patch?: Partial<VoiceSessionState>
): VoiceSessionState {
  return {
    sessionId: null,
    phase: "idle",
    mode: "free",
    target: null,
    userTranscript: "",
    userTranscriptMetadata: null,
    assistantTranscript: "",
    lastInterruptReason: null,
    errorMessage: null,
    playback: {
      active: false,
      queueLength: 0,
      level: 0,
      currentText: ""
    },
    updatedAt: new Date().toISOString(),
    ...patch
  };
}

test("toggleCompanionModeWithVoiceSessionSync: start path refreshes the latest voice session state", async () => {
  const calls: string[] = [];
  const startedCompanion = createCompanionModeState(true);
  const startedVoice = createVoiceSessionState({
    sessionId: "voice-session-1",
    phase: "listening"
  });

  const result = await toggleCompanionModeWithVoiceSessionSync({
    companionModeActive: false,
    voiceSessionActive: false,
    startCompanionMode: async () => {
      calls.push("start-companion");
      return startedCompanion;
    },
    stopCompanionMode: async () => {
      calls.push("stop-companion");
      return createCompanionModeState(false);
    },
    getVoiceSessionState: async () => {
      calls.push("get-voice-session");
      return startedVoice;
    }
  });

  assert.deepEqual(calls, ["start-companion", "get-voice-session"]);
  assert.equal(result.companionState.active, true);
  assert.equal(result.voiceState?.sessionId, "voice-session-1");
  assert.equal(result.voiceState?.phase, "listening");
});

test("toggleCompanionModeWithVoiceSessionSync: stop path also refreshes the latest voice session state", async () => {
  const calls: string[] = [];
  const stoppedCompanion = createCompanionModeState(false);
  const stoppedVoice = createVoiceSessionState();

  const result = await toggleCompanionModeWithVoiceSessionSync({
    companionModeActive: true,
    voiceSessionActive: true,
    startCompanionMode: async () => {
      calls.push("start-companion");
      return createCompanionModeState(true);
    },
    stopCompanionMode: async () => {
      calls.push("stop-companion");
      return stoppedCompanion;
    },
    getVoiceSessionState: async () => {
      calls.push("get-voice-session");
      return stoppedVoice;
    }
  });

  assert.deepEqual(calls, ["stop-companion", "get-voice-session"]);
  assert.equal(result.companionState.active, false);
  assert.equal(result.voiceState?.sessionId, null);
  assert.equal(result.voiceState?.phase, "idle");
});

test("toggleCompanionModeWithVoiceSessionSync: keeps companion result when voice refresh fails", async () => {
  const result = await toggleCompanionModeWithVoiceSessionSync({
    companionModeActive: false,
    voiceSessionActive: false,
    startCompanionMode: async () => createCompanionModeState(true),
    stopCompanionMode: async () => createCompanionModeState(false),
    getVoiceSessionState: async () => {
      throw new Error("ipc unavailable");
    }
  });

  assert.equal(result.companionState.active, true);
  assert.equal(result.voiceState, null);
});

test("toggleCompanionModeWithVoiceSessionSync: starting companion enters and exits realtime voice loading state", async () => {
  const startingStates: boolean[] = [];

  await toggleCompanionModeWithVoiceSessionSync({
    companionModeActive: false,
    voiceSessionActive: false,
    startCompanionMode: async () => createCompanionModeState(true),
    stopCompanionMode: async () => createCompanionModeState(false),
    getVoiceSessionState: async () =>
      createVoiceSessionState({
        sessionId: "voice-session-1",
        phase: "listening"
      }),
    onVoiceStartingChange: (starting) => {
      startingStates.push(starting);
    }
  });

  assert.deepEqual(startingStates, [true, false]);
});

test("toggleCompanionModeWithVoiceSessionSync: existing voice session does not replay loading state", async () => {
  const startingStates: boolean[] = [];

  await toggleCompanionModeWithVoiceSessionSync({
    companionModeActive: false,
    voiceSessionActive: true,
    startCompanionMode: async () => createCompanionModeState(true),
    stopCompanionMode: async () => createCompanionModeState(false),
    getVoiceSessionState: async () =>
      createVoiceSessionState({
        sessionId: "voice-session-1",
        phase: "listening"
      }),
    onVoiceStartingChange: (starting) => {
      startingStates.push(starting);
    }
  });

  assert.deepEqual(startingStates, []);
});
