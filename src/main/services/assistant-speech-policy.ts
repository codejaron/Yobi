export type AssistantSpeechRoute = "none" | "pet" | "realtime";

export function resolveAssistantSpeechRoute(input: {
  speechReplyEnabled: boolean;
  petOnline: boolean;
  unifiedRealtimeVoice: boolean;
  realtimeSessionActive: boolean;
}): AssistantSpeechRoute {
  if (input.realtimeSessionActive) {
    return "realtime";
  }

  if (!input.speechReplyEnabled) {
    return "none";
  }

  if (!input.petOnline) {
    return "none";
  }

  if (!input.unifiedRealtimeVoice) {
    return "pet";
  }

  return "realtime";
}
