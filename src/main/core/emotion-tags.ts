export const EMOTION_TAGS = [
  "happy",
  "sad",
  "shy",
  "angry",
  "surprised",
  "excited",
  "calm"
] as const;

export type EmotionTag = (typeof EMOTION_TAGS)[number];

const EMOTION_PATTERN = "(happy|sad|shy|angry|surprised|excited|calm)";
const THINK_TAG_NAME = "think";

function createEmotionTagRegex(flags: string): RegExp {
  return new RegExp(`<e:${EMOTION_PATTERN}\\s*\\/\\>`, flags);
}

function createEmotionTagToEndRegex(flags: string): RegExp {
  return new RegExp(`<e:${EMOTION_PATTERN}[^>]*$`, flags);
}

function createThinkBlockRegex(flags: string): RegExp {
  return new RegExp(`<${THINK_TAG_NAME}\\b[^>]*>[\\s\\S]*?<\\/${THINK_TAG_NAME}\\s*>`, flags);
}

function createThinkOpenToEndRegex(flags: string): RegExp {
  return new RegExp(`<${THINK_TAG_NAME}\\b[^>]*>[\\s\\S]*$`, flags);
}

function createThinkCloseRegex(flags: string): RegExp {
  return new RegExp(`<\\/${THINK_TAG_NAME}\\s*>`, flags);
}

function createThinkCloseToEndRegex(flags: string): RegExp {
  return new RegExp(`<\\/${THINK_TAG_NAME}[^>]*$`, flags);
}

function stripPotentialTrailingHiddenTag(text: string): string {
  const lastLessThan = text.lastIndexOf("<");
  if (lastLessThan < 0) {
    return text;
  }

  const tail = text.slice(lastLessThan);
  if (tail.includes(">")) {
    return text;
  }

  const normalizedTail = tail.toLowerCase();
  const knownPrefixes = ["<think", "</think", "<e:"];
  const isKnownPrefix = knownPrefixes.some((prefix) => prefix.startsWith(normalizedTail));
  return isKnownPrefix ? text.slice(0, lastLessThan) : text;
}

function stripHiddenTags(text: string): string {
  const withoutThink = text
    .replace(createThinkBlockRegex("gi"), "")
    .replace(createThinkOpenToEndRegex("gi"), "")
    .replace(createThinkCloseRegex("gi"), "")
    .replace(createThinkCloseToEndRegex("gi"), "");

  return stripPotentialTrailingHiddenTag(
    withoutThink.replace(createEmotionTagRegex("gi"), "").replace(createEmotionTagToEndRegex("gi"), "")
  );
}

export function extractEmotionTag(text: string): {
  cleanedText: string;
  emotion: EmotionTag | null;
} {
  const withoutThink = text
    .replace(createThinkBlockRegex("gi"), "")
    .replace(createThinkOpenToEndRegex("gi"), "")
    .replace(createThinkCloseRegex("gi"), "")
    .replace(createThinkCloseToEndRegex("gi"), "");

  const matches = Array.from(withoutThink.matchAll(createEmotionTagRegex("gi")));
  const emotion = matches.length > 0 ? (matches[matches.length - 1][1].toLowerCase() as EmotionTag) : null;

  return {
    cleanedText: stripHiddenTags(withoutThink),
    emotion
  };
}

export function stripEmotionTags(text: string): string {
  return stripHiddenTags(text);
}

export interface EmotionTagStripper {
  push: (delta: string) => string;
  flush: () => string;
}

export function createEmotionTagStripper(): EmotionTagStripper {
  let raw = "";
  let emittedLength = 0;

  return {
    push: (delta: string) => {
      raw += delta;
      const visible = stripHiddenTags(raw);
      if (visible.length <= emittedLength) {
        return "";
      }

      const next = visible.slice(emittedLength);
      emittedLength = visible.length;
      return next;
    },
    flush: () => {
      const visible = stripHiddenTags(raw);
      if (visible.length <= emittedLength) {
        raw = "";
        emittedLength = 0;
        return "";
      }

      const next = visible.slice(emittedLength);
      raw = "";
      emittedLength = 0;
      return next;
    }
  };
}
