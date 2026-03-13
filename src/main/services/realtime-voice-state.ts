import type {
  RealtimeVoiceMode,
  VoicePlaybackState,
  VoiceSessionPhase,
  VoiceSessionState,
  VoiceSessionTarget
} from "@shared/types";

type VoiceSessionReducerEvent =
  | { type: "session-started" }
  | { type: "speech-started" }
  | { type: "speech-ended" }
  | { type: "assistant-thinking-started" }
  | { type: "assistant-playback-started" }
  | { type: "assistant-playback-finished" }
  | { type: "barge-in-detected"; reason: "vad" | "manual" | "system" }
  | { type: "session-stopped" }
  | { type: "error"; message: string }
  | { type: "playback-level"; level: number; queueLength?: number; currentText?: string };

interface CreateVoiceSessionStateInput {
  sessionId: string;
  mode: RealtimeVoiceMode;
  target: Pick<VoiceSessionTarget, "resourceId" | "threadId">;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createPlaybackState(): VoicePlaybackState {
  return {
    active: false,
    queueLength: 0,
    level: 0,
    currentText: ""
  };
}

export function createVoiceSessionState(input: CreateVoiceSessionStateInput): VoiceSessionState {
  return {
    sessionId: input.sessionId,
    phase: "idle",
    mode: input.mode,
    target: {
      resourceId: input.target.resourceId,
      threadId: input.target.threadId,
      source: "voice"
    },
    userTranscript: "",
    userTranscriptMetadata: null,
    assistantTranscript: "",
    lastInterruptReason: null,
    errorMessage: null,
    playback: createPlaybackState(),
    updatedAt: nowIso()
  };
}

function withPhase(state: VoiceSessionState, phase: VoiceSessionPhase): VoiceSessionState {
  return {
    ...state,
    phase,
    updatedAt: nowIso()
  };
}

export function reduceVoiceSessionState(
  state: VoiceSessionState,
  event: VoiceSessionReducerEvent
): VoiceSessionState {
  switch (event.type) {
    case "session-started":
      return withPhase({
        ...state,
        errorMessage: null,
        lastInterruptReason: null,
        userTranscriptMetadata: null
      }, "listening");
    case "speech-started":
      return withPhase(state, "user-speaking");
    case "speech-ended":
      return withPhase(state, "transcribing");
    case "assistant-thinking-started":
      return withPhase(state, "assistant-thinking");
    case "assistant-playback-started":
      return {
        ...withPhase(state, "assistant-speaking"),
        playback: {
          ...state.playback,
          active: true
        }
      };
    case "assistant-playback-finished":
      return {
        ...withPhase(state, state.mode === "free" ? "listening" : "idle"),
        playback: {
          ...state.playback,
          active: false,
          queueLength: 0,
          level: 0,
          currentText: ""
        }
      };
    case "barge-in-detected":
      return {
        ...withPhase(state, "interrupted"),
        lastInterruptReason: event.reason,
        playback: {
          ...state.playback,
          active: false,
          queueLength: 0,
          level: 0
        }
      };
    case "session-stopped":
      return {
        ...withPhase(state, "idle"),
        lastInterruptReason: null,
        errorMessage: null,
        userTranscriptMetadata: null,
        playback: createPlaybackState()
      };
    case "error":
      return {
        ...withPhase(state, "error"),
        errorMessage: event.message
      };
    case "playback-level":
      return {
        ...state,
        playback: {
          active: state.playback.active,
          queueLength: typeof event.queueLength === "number" ? Math.max(0, Math.round(event.queueLength)) : state.playback.queueLength,
          level: Math.max(0, event.level),
          currentText: typeof event.currentText === "string" ? event.currentText : state.playback.currentText
        },
        updatedAt: nowIso()
      };
    default:
      return state;
  }
}
