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
