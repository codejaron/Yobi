import type { RealtimeVoiceMode } from "@shared/types";

export function shouldAutoStartVoiceSession(input: {
  enabled: boolean;
  mode: RealtimeVoiceMode;
}): boolean {
  return false;
}
