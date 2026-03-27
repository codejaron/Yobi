import type { CompanionModeState, VoiceSessionState } from "./types";

export function shouldDisableConsoleMicButton(input: {
  pendingApproval: boolean;
  recording: boolean;
  transcribing: boolean;
  busy: boolean;
}): boolean {
  return (input.pendingApproval && !input.recording) || input.transcribing || input.busy;
}

export function getRealtimeVoiceToggleButtonState(input: {
  sessionActive: boolean;
  starting: boolean;
}): {
  label: string;
  disabled: boolean;
  loading: boolean;
} {
  if (input.starting) {
    return {
      label: "连接中…",
      disabled: true,
      loading: true
    };
  }

  if (input.sessionActive) {
    return {
      label: "停止实时语音",
      disabled: false,
      loading: false
    };
  }

  return {
    label: "启动实时语音",
    disabled: false,
    loading: false
  };
}

export async function toggleCompanionModeWithVoiceSessionSync(input: {
  companionModeActive: boolean;
  voiceSessionActive: boolean;
  startCompanionMode: () => Promise<CompanionModeState>;
  stopCompanionMode: () => Promise<CompanionModeState>;
  getVoiceSessionState: () => Promise<VoiceSessionState>;
  onVoiceStartingChange?: (starting: boolean) => void;
}): Promise<{
  companionState: CompanionModeState;
  voiceState: VoiceSessionState | null;
}> {
  const shouldShowVoiceStarting = !input.companionModeActive && !input.voiceSessionActive;
  if (shouldShowVoiceStarting) {
    input.onVoiceStartingChange?.(true);
  }

  try {
    const companionState = input.companionModeActive
      ? await input.stopCompanionMode()
      : await input.startCompanionMode();

    const voiceState = await input.getVoiceSessionState().catch(() => null);
    return {
      companionState,
      voiceState
    };
  } finally {
    if (shouldShowVoiceStarting) {
      input.onVoiceStartingChange?.(false);
    }
  }
}
