import test from "node:test";
import assert from "node:assert/strict";
import {
  applyVoiceSessionEventToConsoleChatLiveVoiceState,
  createConsoleChatLiveVoiceState
} from "@shared/console-chat-live-voice";
import type { VoiceSessionEvent, VoiceSessionState } from "@shared/types";

function createVoiceSessionState(
  patch: Partial<VoiceSessionState> & Pick<VoiceSessionState, "sessionId" | "phase">
): VoiceSessionState {
  return {
    sessionId: patch.sessionId,
    phase: patch.phase,
    mode: "free",
    target: patch.sessionId
      ? {
          resourceId: "primary-user",
          threadId: "primary-thread",
          source: "voice"
        }
      : null,
    userTranscript: patch.userTranscript ?? "",
    userTranscriptMetadata: patch.userTranscriptMetadata ?? null,
    assistantTranscript: patch.assistantTranscript ?? "",
    lastInterruptReason: patch.lastInterruptReason ?? null,
    errorMessage: patch.errorMessage ?? null,
    playback: patch.playback ?? {
      active: false,
      queueLength: 0,
      level: 0,
      currentText: ""
    },
    updatedAt: patch.updatedAt ?? "2026-03-14T00:00:00.000Z"
  };
}

function createStateEvent(state: VoiceSessionState): VoiceSessionEvent {
  return {
    type: "state",
    state,
    timestamp: "2026-03-14T00:00:00.000Z"
  };
}

test("console chat live voice: user partial and final update a single bubble", () => {
  let state = createConsoleChatLiveVoiceState();
  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(
    state,
    createStateEvent(createVoiceSessionState({ sessionId: "session-1", phase: "listening" }))
  );

  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(state, {
    type: "user-transcript",
    text: "你",
    isFinal: false,
    timestamp: "2026-03-14T00:00:01.000Z"
  });
  const partialId = state.messages[0]?.id;

  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(state, {
    type: "user-transcript",
    text: "你好呀",
    isFinal: true,
    timestamp: "2026-03-14T00:00:02.000Z"
  });

  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.id, partialId);
  assert.equal(state.messages[0]?.text, "你好呀");
  assert.equal(state.messages[0]?.state, "done");
  assert.equal(state.turnStage, "assistant-pending");
});

test("console chat live voice: assistant partial and final stay on the same turn", () => {
  let state = createConsoleChatLiveVoiceState();
  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(
    state,
    createStateEvent(createVoiceSessionState({ sessionId: "session-1", phase: "listening" }))
  );
  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(state, {
    type: "user-transcript",
    text: "你好呀",
    isFinal: true,
    timestamp: "2026-03-14T00:00:01.000Z"
  });

  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(state, {
    type: "assistant-transcript",
    text: "在",
    isFinal: false,
    timestamp: "2026-03-14T00:00:02.000Z"
  });
  const assistantId = state.messages[1]?.id;

  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(state, {
    type: "assistant-transcript",
    text: "在这等着。",
    isFinal: true,
    timestamp: "2026-03-14T00:00:03.000Z"
  });

  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[0]?.role, "user");
  assert.equal(state.messages[1]?.role, "assistant");
  assert.equal(state.messages[1]?.id, assistantId);
  assert.equal(state.messages[1]?.text, "在这等着。");
  assert.equal(state.messages[1]?.state, "done");
  assert.equal(state.turnStage, "idle");
});

test("console chat live voice: second user turn gets a new turn id", () => {
  let state = createConsoleChatLiveVoiceState();
  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(
    state,
    createStateEvent(createVoiceSessionState({ sessionId: "session-1", phase: "listening" }))
  );
  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(state, {
    type: "user-transcript",
    text: "第一句",
    isFinal: true,
    timestamp: "2026-03-14T00:00:01.000Z"
  });
  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(state, {
    type: "assistant-transcript",
    text: "收到",
    isFinal: true,
    timestamp: "2026-03-14T00:00:02.000Z"
  });
  const firstTurnUserId = state.messages[0]?.id;

  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(state, {
    type: "user-transcript",
    text: "第二句",
    isFinal: false,
    timestamp: "2026-03-14T00:00:03.000Z"
  });

  const lastMessage = state.messages[state.messages.length - 1];
  assert.notEqual(lastMessage?.id, firstTurnUserId);
  assert.equal(lastMessage?.id, "voice-live:session-1:2:user");
  assert.equal(state.activeTurnIndex, 2);
});

test("console chat live voice: interrupt closes the current assistant bubble and next user starts a new turn", () => {
  let state = createConsoleChatLiveVoiceState();
  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(
    state,
    createStateEvent(createVoiceSessionState({ sessionId: "session-1", phase: "listening" }))
  );
  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(state, {
    type: "user-transcript",
    text: "你好呀",
    isFinal: true,
    timestamp: "2026-03-14T00:00:01.000Z"
  });
  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(state, {
    type: "assistant-transcript",
    text: "我在",
    isFinal: false,
    timestamp: "2026-03-14T00:00:02.000Z"
  });

  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(
    state,
    createStateEvent(
      createVoiceSessionState({
        sessionId: "session-1",
        phase: "interrupted",
        userTranscript: "你好呀",
        assistantTranscript: "我在"
      })
    )
  );

  assert.equal(state.turnStage, "idle");
  assert.equal(state.messages[1]?.state, "done");

  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(state, {
    type: "user-transcript",
    text: "继续聊",
    isFinal: false,
    timestamp: "2026-03-14T00:00:03.000Z"
  });

  assert.equal(state.messages[state.messages.length - 1]?.id, "voice-live:session-1:2:user");
  assert.equal(state.activeTurnIndex, 2);
});

test("console chat live voice: snapshot rebuilds an in-progress turn when the page attaches mid-session", () => {
  let state = createConsoleChatLiveVoiceState();
  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(
    state,
    createStateEvent(
      createVoiceSessionState({
        sessionId: "session-1",
        phase: "assistant-speaking",
        userTranscript: "你在干嘛呀",
        assistantTranscript: "在这等着。"
      })
    )
  );

  assert.equal(state.activeTurnIndex, 1);
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[0]?.state, "done");
  assert.equal(state.messages[1]?.state, "streaming");
  assert.equal(state.turnStage, "assistant");
});

test("console chat live voice: a fresh listening snapshot does not resurrect an already completed turn", () => {
  let state = createConsoleChatLiveVoiceState();
  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(
    state,
    createStateEvent(
      createVoiceSessionState({
        sessionId: "session-1",
        phase: "listening",
        userTranscript: "你在干嘛呀",
        assistantTranscript: "在这等着。"
      })
    )
  );

  assert.equal(state.messages.length, 0);
  assert.equal(state.activeTurnIndex, 0);
});

test("console chat live voice: session stop and restart keep finished bubbles while resetting the cursor", () => {
  let state = createConsoleChatLiveVoiceState();
  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(
    state,
    createStateEvent(createVoiceSessionState({ sessionId: "session-1", phase: "listening" }))
  );
  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(state, {
    type: "user-transcript",
    text: "你好呀",
    isFinal: true,
    timestamp: "2026-03-14T00:00:01.000Z"
  });
  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(state, {
    type: "assistant-transcript",
    text: "收到",
    isFinal: true,
    timestamp: "2026-03-14T00:00:02.000Z"
  });

  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(
    state,
    createStateEvent(createVoiceSessionState({ sessionId: null, phase: "idle" }))
  );

  assert.equal(state.sessionId, null);
  assert.equal(state.activeTurnIndex, 0);
  assert.equal(state.messages.length, 2);

  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(
    state,
    createStateEvent(createVoiceSessionState({ sessionId: "session-2", phase: "listening" }))
  );
  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(state, {
    type: "user-transcript",
    text: "新会话",
    isFinal: false,
    timestamp: "2026-03-14T00:00:03.000Z"
  });

  assert.equal(state.messages.length, 3);
  assert.equal(state.messages[2]?.id, "voice-live:session-2:1:user");
});

test("console chat live voice: repeated state snapshots do not duplicate the same completed turn", () => {
  let state = createConsoleChatLiveVoiceState();
  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(
    state,
    createStateEvent(createVoiceSessionState({ sessionId: "session-1", phase: "listening" }))
  );
  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(state, {
    type: "user-transcript",
    text: "你好呀",
    isFinal: true,
    timestamp: "2026-03-14T00:00:01.000Z"
  });
  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(state, {
    type: "assistant-transcript",
    text: "收到",
    isFinal: true,
    timestamp: "2026-03-14T00:00:02.000Z"
  });

  state = applyVoiceSessionEventToConsoleChatLiveVoiceState(
    state,
    createStateEvent(
      createVoiceSessionState({
        sessionId: "session-1",
        phase: "listening",
        userTranscript: "你好呀",
        assistantTranscript: "收到"
      })
    )
  );

  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[0]?.id, "voice-live:session-1:1:user");
  assert.equal(state.messages[1]?.id, "voice-live:session-1:1:assistant");
});
