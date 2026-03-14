import type { VoiceSessionEvent, VoiceSessionPhase, VoiceSessionState } from "./types";

export type ConsoleChatLiveVoiceTurnStage = "idle" | "user" | "assistant-pending" | "assistant";

export interface ConsoleChatLiveVoiceMessage {
  id: string;
  requestId: string;
  role: "user" | "assistant";
  text: string;
  state: "streaming" | "done";
}

export interface ConsoleChatLiveVoiceState {
  sessionId: string | null;
  activeTurnIndex: number;
  turnStage: ConsoleChatLiveVoiceTurnStage;
  messages: ConsoleChatLiveVoiceMessage[];
}

export type ConsoleChatLiveVoiceAction =
  | { type: "clear" }
  | { type: "state"; state: VoiceSessionState }
  | { type: "user-transcript"; text: string; isFinal: boolean }
  | { type: "assistant-transcript"; text: string; isFinal: boolean };

interface TurnMessages {
  user: ConsoleChatLiveVoiceMessage | null;
  assistant: ConsoleChatLiveVoiceMessage | null;
}

export function createConsoleChatLiveVoiceState(): ConsoleChatLiveVoiceState {
  return {
    sessionId: null,
    activeTurnIndex: 0,
    turnStage: "idle",
    messages: []
  };
}

export function applyVoiceSessionEventToConsoleChatLiveVoiceState(
  state: ConsoleChatLiveVoiceState,
  event: VoiceSessionEvent
): ConsoleChatLiveVoiceState {
  if (event.type === "state") {
    return reduceConsoleChatLiveVoiceState(state, {
      type: "state",
      state: event.state
    });
  }

  if (event.type === "user-transcript") {
    return reduceConsoleChatLiveVoiceState(state, {
      type: "user-transcript",
      text: event.text,
      isFinal: event.isFinal
    });
  }

  if (event.type === "assistant-transcript") {
    return reduceConsoleChatLiveVoiceState(state, {
      type: "assistant-transcript",
      text: event.text,
      isFinal: event.isFinal
    });
  }

  return state;
}

export function reduceConsoleChatLiveVoiceState(
  current: ConsoleChatLiveVoiceState,
  action: ConsoleChatLiveVoiceAction
): ConsoleChatLiveVoiceState {
  if (action.type === "clear") {
    return createConsoleChatLiveVoiceState();
  }

  if (action.type === "user-transcript") {
    const sessionId = current.sessionId;
    if (!sessionId || !action.text.trim()) {
      return current;
    }

    const turnIndex =
      current.turnStage === "user"
        ? Math.max(1, current.activeTurnIndex)
        : Math.max(1, current.activeTurnIndex + 1);
    const requestId = buildTurnRequestId(sessionId, turnIndex);

    return {
      ...current,
      activeTurnIndex: turnIndex,
      turnStage: action.isFinal ? "assistant-pending" : "user",
      messages: upsertMessage(current.messages, {
        id: buildMessageId(sessionId, turnIndex, "user"),
        requestId,
        role: "user",
        text: action.text,
        state: action.isFinal ? "done" : "streaming"
      })
    };
  }

  if (action.type === "assistant-transcript") {
    const sessionId = current.sessionId;
    if (!sessionId || !action.text.trim()) {
      return current;
    }

    const turnIndex = Math.max(1, current.activeTurnIndex || 1);
    const requestId = buildTurnRequestId(sessionId, turnIndex);

    return {
      ...current,
      activeTurnIndex: turnIndex,
      turnStage: action.isFinal ? "idle" : "assistant",
      messages: upsertMessage(current.messages, {
        id: buildMessageId(sessionId, turnIndex, "assistant"),
        requestId,
        role: "assistant",
        text: action.text,
        state: action.isFinal ? "done" : "streaming"
      })
    };
  }

  return applyVoiceSessionSnapshot(current, action.state);
}

function applyVoiceSessionSnapshot(
  current: ConsoleChatLiveVoiceState,
  snapshot: VoiceSessionState
): ConsoleChatLiveVoiceState {
  let next = syncSession(current, snapshot.sessionId);

  if (!snapshot.sessionId) {
    return next;
  }

  if (snapshot.phase === "interrupted" || snapshot.phase === "error") {
    next = closeCurrentTurn(next);
  }

  const hasUser = snapshot.userTranscript.trim().length > 0;
  const hasAssistant = snapshot.assistantTranscript.trim().length > 0;
  if (!hasUser && !hasAssistant) {
    return next;
  }

  if (
    next.activeTurnIndex === 0 &&
    next.turnStage === "idle" &&
    (snapshot.phase === "idle" || snapshot.phase === "listening")
  ) {
    return next;
  }

  const turnIndex = resolveSnapshotTurnIndex(next, snapshot);
  let messages = next.messages;
  if (hasUser) {
    messages = upsertMessage(messages, {
      id: buildMessageId(snapshot.sessionId, turnIndex, "user"),
      requestId: buildTurnRequestId(snapshot.sessionId, turnIndex),
      role: "user",
      text: snapshot.userTranscript,
      state: isUserFinalPhase(snapshot.phase) ? "done" : "streaming"
    });
  }

  if (hasAssistant) {
    messages = upsertMessage(messages, {
      id: buildMessageId(snapshot.sessionId, turnIndex, "assistant"),
      requestId: buildTurnRequestId(snapshot.sessionId, turnIndex),
      role: "assistant",
      text: snapshot.assistantTranscript,
      state: isAssistantFinalPhase(snapshot.phase) ? "done" : "streaming"
    });
  }

  return {
    ...next,
    activeTurnIndex: turnIndex,
    turnStage: deriveTurnStage(snapshot),
    messages
  };
}

function syncSession(
  current: ConsoleChatLiveVoiceState,
  sessionId: string | null
): ConsoleChatLiveVoiceState {
  if (current.sessionId === sessionId) {
    return current;
  }

  const closed = closeCurrentTurn(current);
  return {
    ...closed,
    sessionId,
    activeTurnIndex: 0,
    turnStage: "idle"
  };
}

function closeCurrentTurn(current: ConsoleChatLiveVoiceState): ConsoleChatLiveVoiceState {
  if (!current.sessionId || current.activeTurnIndex <= 0) {
    return current.turnStage === "idle"
      ? current
      : {
          ...current,
          turnStage: "idle"
        };
  }

  const currentTurn = getTurnMessages(current.messages, current.sessionId, current.activeTurnIndex);
  const needsUpdate =
    currentTurn.user?.state === "streaming" || currentTurn.assistant?.state === "streaming";
  if (!needsUpdate && current.turnStage === "idle") {
    return current;
  }

  const messages = current.messages.map((message) => {
    if (
      message.id === currentTurn.user?.id ||
      message.id === currentTurn.assistant?.id
    ) {
      return {
        ...message,
        state: "done" as const
      };
    }

    return message;
  });

  return {
    ...current,
    turnStage: "idle",
    messages
  };
}

function resolveSnapshotTurnIndex(
  current: ConsoleChatLiveVoiceState,
  snapshot: VoiceSessionState
): number {
  const activeTurnIndex = Math.max(1, current.activeTurnIndex || 1);
  if (
    current.activeTurnIndex > 0 &&
    snapshotMatchesTurn(snapshot, getTurnMessages(current.messages, snapshot.sessionId!, activeTurnIndex))
  ) {
    return activeTurnIndex;
  }

  if (current.turnStage !== "idle") {
    return activeTurnIndex;
  }

  if (snapshot.phase === "interrupted" || snapshot.phase === "error") {
    return activeTurnIndex;
  }

  return Math.max(1, current.activeTurnIndex + 1);
}

function snapshotMatchesTurn(snapshot: VoiceSessionState, turn: TurnMessages): boolean {
  const userText = snapshot.userTranscript.trim();
  const assistantText = snapshot.assistantTranscript.trim();
  if (!turn.user && !turn.assistant) {
    return false;
  }

  if (userText) {
    if (turn.user?.text !== snapshot.userTranscript) {
      return false;
    }
  } else if (turn.user) {
    return false;
  }

  if (assistantText) {
    if (turn.assistant?.text !== snapshot.assistantTranscript) {
      return false;
    }
  } else if (turn.assistant) {
    return false;
  }

  return true;
}

function deriveTurnStage(snapshot: VoiceSessionState): ConsoleChatLiveVoiceTurnStage {
  const hasUser = snapshot.userTranscript.trim().length > 0;
  const hasAssistant = snapshot.assistantTranscript.trim().length > 0;
  if (snapshot.phase === "interrupted" || snapshot.phase === "error") {
    return "idle";
  }

  if (hasAssistant) {
    return isAssistantFinalPhase(snapshot.phase) ? "idle" : "assistant";
  }

  if (hasUser) {
    return isUserFinalPhase(snapshot.phase) ? "assistant-pending" : "user";
  }

  return "idle";
}

function isUserFinalPhase(phase: VoiceSessionPhase): boolean {
  return phase !== "user-speaking";
}

function isAssistantFinalPhase(phase: VoiceSessionPhase): boolean {
  return (
    phase === "idle" ||
    phase === "listening" ||
    phase === "interrupted" ||
    phase === "error"
  );
}

function getTurnMessages(
  messages: ConsoleChatLiveVoiceMessage[],
  sessionId: string,
  turnIndex: number
): TurnMessages {
  const userId = buildMessageId(sessionId, turnIndex, "user");
  const assistantId = buildMessageId(sessionId, turnIndex, "assistant");

  return {
    user: messages.find((message) => message.id === userId) ?? null,
    assistant: messages.find((message) => message.id === assistantId) ?? null
  };
}

function upsertMessage(
  messages: ConsoleChatLiveVoiceMessage[],
  nextMessage: ConsoleChatLiveVoiceMessage
): ConsoleChatLiveVoiceMessage[] {
  const index = messages.findIndex((message) => message.id === nextMessage.id);
  if (index < 0) {
    return [...messages, nextMessage];
  }

  const next = [...messages];
  next[index] = nextMessage;
  return next;
}

function buildTurnRequestId(sessionId: string, turnIndex: number): string {
  return `voice-live:${sessionId}:${turnIndex}`;
}

function buildMessageId(
  sessionId: string,
  turnIndex: number,
  role: ConsoleChatLiveVoiceMessage["role"]
): string {
  return `${buildTurnRequestId(sessionId, turnIndex)}:${role}`;
}
