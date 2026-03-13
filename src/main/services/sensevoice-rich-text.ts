import type { SpeechRecognitionMetadata } from "@shared/types";

const TAG_PATTERN = /<\|([^|>]+)\|>/g;

const LANGUAGE_TAGS = new Set([
  "auto",
  "zh",
  "en",
  "yue",
  "ja",
  "ko",
  "nospeech"
]);

const EMOTION_TAGS = new Set([
  "ANGRY",
  "DISGUSTED",
  "FEARFUL",
  "HAPPY",
  "NEUTRAL",
  "SAD",
  "SURPRISED",
  "EMO_UNKNOWN"
]);

const EVENT_TAGS = new Set([
  "Speech",
  "BGM",
  "Applause",
  "Laughter",
  "Cry",
  "Cough",
  "Sneeze",
  "Breath",
  "Shout",
  "Singing",
  "Speech_Noise",
  "Music"
]);

function normalizeEmotion(tag: string): string {
  return tag.toLowerCase().replace(/_/g, "-");
}

function normalizeEvent(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, "-").replace(/_/g, "-");
}

export function parseSenseVoiceRichText(input: string): {
  text: string;
  metadata: SpeechRecognitionMetadata;
} {
  const source = input.trim();
  const rawTags = Array.from(source.matchAll(TAG_PATTERN), (match) => match[1]?.trim() ?? "").filter(Boolean);
  const cleanedText = source.replace(TAG_PATTERN, "").trim();

  let language: string | null = null;
  let emotion: string | null = null;
  let event: string | null = null;

  for (const rawTag of rawTags) {
    if (!language && LANGUAGE_TAGS.has(rawTag)) {
      language = rawTag;
      continue;
    }

    const upper = rawTag.toUpperCase();
    if (!emotion && EMOTION_TAGS.has(upper)) {
      emotion = normalizeEmotion(upper);
      continue;
    }

    if (!event && (EVENT_TAGS.has(rawTag) || EVENT_TAGS.has(rawTag.replace(/-/g, "_")))) {
      event = normalizeEvent(rawTag);
    }
  }

  return {
    text: cleanedText,
    metadata: {
      language,
      emotion,
      event,
      rawTags
    }
  };
}
