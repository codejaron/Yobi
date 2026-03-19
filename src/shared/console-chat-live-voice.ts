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

    const activeTurnIndex = Math.max(1, current.activeTurnIndex || 1);
    const currentTurn =
      current.activeTurnIndex > 0
        ? getTurnMessages(current.messages, sessionId, activeTurnIndex)
        : { user: null, assistant: null };
    const reuseCurrentTurn = shouldReuseCurrentUserTurn(current, currentTurn, action.text);
    const turnIndex = reuseCurrentTurn
      ? activeTurnIndex
      : Math.max(1, current.activeTurnIndex + 1);
    const requestId = buildTurnRequestId(sessionId, turnIndex);
    const nextText = mergeTranscriptText(currentTurn.user?.text ?? "", action.text);
    const nextState =
      reuseCurrentTurn && currentTurn.user?.state === "done"
        ? "done"
        : action.isFinal
          ? "done"
          : "streaming";

    return {
      ...current,
      activeTurnIndex: turnIndex,
      turnStage: resolveUserTurnStage(current.turnStage, reuseCurrentTurn, action.isFinal),
      messages: upsertMessage(current.messages, {
        id: buildMessageId(sessionId, turnIndex, "user"),
        requestId,
        role: "user",
        text: nextText,
        state: nextState
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
  const normalizedSnapshot = normalizeSnapshotForTransientRendering(snapshot);
  let next = syncSession(current, normalizedSnapshot.sessionId);

  if (!normalizedSnapshot.sessionId) {
    return next;
  }

  if (normalizedSnapshot.phase === "interrupted" || normalizedSnapshot.phase === "error") {
    next = closeCurrentTurn(next);
  }

  const hasUser = normalizedSnapshot.userTranscript.trim().length > 0;
  const hasAssistant = normalizedSnapshot.assistantTranscript.trim().length > 0;
  if (!hasUser && !hasAssistant) {
    return next;
  }

  if (
    next.activeTurnIndex === 0 &&
    next.turnStage === "idle" &&
    (normalizedSnapshot.phase === "idle" || normalizedSnapshot.phase === "listening")
  ) {
    return next;
  }

  const turnIndex = resolveSnapshotTurnIndex(next, normalizedSnapshot);
  let messages = next.messages;
  if (hasUser) {
    messages = upsertMessage(messages, {
      id: buildMessageId(normalizedSnapshot.sessionId, turnIndex, "user"),
      requestId: buildTurnRequestId(normalizedSnapshot.sessionId, turnIndex),
      role: "user",
      text: normalizedSnapshot.userTranscript,
      state: isUserFinalPhase(normalizedSnapshot.phase) ? "done" : "streaming"
    });
  }

  if (hasAssistant) {
    messages = upsertMessage(messages, {
      id: buildMessageId(normalizedSnapshot.sessionId, turnIndex, "assistant"),
      requestId: buildTurnRequestId(normalizedSnapshot.sessionId, turnIndex),
      role: "assistant",
      text: normalizedSnapshot.assistantTranscript,
      state: isAssistantFinalPhase(normalizedSnapshot.phase) ? "done" : "streaming"
    });
  }

  return {
    ...next,
    activeTurnIndex: turnIndex,
    turnStage: deriveTurnStage(normalizedSnapshot),
    messages
  };
}

function normalizeSnapshotForTransientRendering(snapshot: VoiceSessionState): VoiceSessionState {
  if (snapshot.userTranscript.trim()) {
    return snapshot;
  }

  if (
    snapshot.phase === "idle" ||
    snapshot.phase === "listening" ||
    snapshot.phase === "user-speaking" ||
    snapshot.phase === "transcribing" ||
    snapshot.phase === "interrupted" ||
    snapshot.phase === "error"
  ) {
    return {
      ...snapshot,
      assistantTranscript: ""
    };
  }

  return snapshot;
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

function shouldReuseCurrentUserTurn(
  current: ConsoleChatLiveVoiceState,
  turn: TurnMessages,
  nextText: string
): boolean {
  if (current.turnStage === "user") {
    return true;
  }

  if (!turn.user) {
    return false;
  }

  if (current.turnStage === "assistant-pending") {
    return transcriptsBelongToSameUtterance(turn.user.text, nextText);
  }

  if (current.turnStage === "assistant") {
    return normalizeTranscriptText(turn.user.text) === normalizeTranscriptText(nextText);
  }

  return false;
}

function resolveUserTurnStage(
  currentTurnStage: ConsoleChatLiveVoiceTurnStage,
  reuseCurrentTurn: boolean,
  isFinal: boolean
): ConsoleChatLiveVoiceTurnStage {
  if (reuseCurrentTurn && currentTurnStage === "assistant") {
    return "assistant";
  }

  if (reuseCurrentTurn && !isFinal && currentTurnStage === "assistant-pending") {
    return "assistant-pending";
  }

  return isFinal ? "assistant-pending" : "user";
}

function transcriptsBelongToSameUtterance(currentText: string, nextText: string): boolean {
  const current = normalizeTranscriptText(currentText);
  const next = normalizeTranscriptText(nextText);
  if (!current || !next) {
    return false;
  }

  return current === next || current.startsWith(next) || next.startsWith(current);
}

function mergeTranscriptText(currentText: string, nextText: string): string {
  const current = normalizeTranscriptText(currentText);
  const next = normalizeTranscriptText(nextText);
  if (!current) {
    return nextText;
  }

  if (!next) {
    return currentText;
  }

  if (next.startsWith(current)) {
    return nextText;
  }

  if (current.startsWith(next)) {
    return currentText;
  }

  return nextText;
}

function normalizeTranscriptText(text: string): string {
  return text.trim();
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
