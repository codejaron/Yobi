import { stripEmotionTags } from "@main/core/emotion-tags";
import type { AppConfig, HistoryMessageMeta, RealtimeVoiceMode } from "@shared/types";

interface BuildInterruptedAssistantCommitInput {
  fullText: string;
  playedText: string;
  sessionId: string;
  mode: RealtimeVoiceMode;
  asrProvider: AppConfig["voice"]["asrProvider"];
  ttsProvider: AppConfig["voice"]["ttsProvider"];
}

export function buildInterruptedAssistantCommit(input: BuildInterruptedAssistantCommitInput): {
  text: string;
  metadata: HistoryMessageMeta;
} {
  const visibleFullText = stripEmotionTags(input.fullText).trim();
  const visiblePlayedText = stripEmotionTags(input.playedText).trim();
  const text = visiblePlayedText || visibleFullText;

  return {
    text,
    metadata: {
      voice: {
        source: "voice",
        sessionId: input.sessionId,
        mode: input.mode,
        interrupted: true,
        playedTextLength: text.length,
        asrProvider: input.asrProvider,
        ttsProvider: input.ttsProvider
      }
    }
  };
}
