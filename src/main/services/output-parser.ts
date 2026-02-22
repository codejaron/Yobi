import type { AssistantOutputParseResult } from "@shared/types";

const REMINDER_PATTERN = /\[reminder\]([\s\S]*?)\[\/reminder\]/gi;
const VOICE_PATTERN = /\[voice\]([\s\S]*?)\[\/voice\]/gi;
const STICKER_PATTERN = /\[sticker:([^\]]+)\]/gi;
const EMOTION_PATTERN = /\[(happy|sad|shy|angry|excited|calm|idle)\]/gi;

function squeeze(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function parseReminderPayload(payload: string): { time: string; text: string } | null {
  try {
    const parsed = JSON.parse(payload) as { time?: string; text?: string };
    const at = parsed.time ? new Date(parsed.time) : null;
    if (!at || Number.isNaN(at.getTime())) {
      return null;
    }

    const text = parsed.text?.trim();
    if (!text) {
      return null;
    }

    return {
      time: at.toISOString(),
      text
    };
  } catch {
    return null;
  }
}

export function parseAssistantOutput(rawText: string): AssistantOutputParseResult {
  const reminders: Array<{ time: string; text: string }> = [];
  const voiceTexts: string[] = [];
  const stickerKeywords: string[] = [];
  const emotions: string[] = [];

  let working = rawText;

  working = working.replace(REMINDER_PATTERN, (_match, payload: string) => {
    const reminder = parseReminderPayload(payload);
    if (reminder) {
      reminders.push(reminder);
    }
    return "";
  });

  working = working.replace(VOICE_PATTERN, (_match, voiceText: string) => {
    const normalized = squeeze(voiceText);
    if (normalized) {
      voiceTexts.push(normalized);
    }
    return "";
  });

  working = working.replace(STICKER_PATTERN, (_match, keyword: string) => {
    const normalized = keyword.trim();
    if (normalized) {
      stickerKeywords.push(normalized);
    }
    return "";
  });

  working = working.replace(EMOTION_PATTERN, (_match, emotion: string) => {
    emotions.push(emotion.toLowerCase());
    return "";
  });

  return {
    visibleText: squeeze(working),
    voiceTexts,
    stickerKeywords,
    reminders,
    emotions
  };
}

export function mergeVoiceIntoText(parsed: AssistantOutputParseResult): string {
  const chunks = [...parsed.voiceTexts, parsed.visibleText].filter(Boolean);
  return squeeze(chunks.join("\n"));
}
