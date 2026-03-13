export function shouldDisableConsoleMicButton(input: {
  pendingApproval: boolean;
  recording: boolean;
  transcribing: boolean;
  busy: boolean;
}): boolean {
  return (input.pendingApproval && !input.recording) || input.transcribing || input.busy;
}
