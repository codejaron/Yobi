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

function createEmotionTagRegex(flags: string): RegExp {
  return new RegExp(`<e:${EMOTION_PATTERN}\\s*\\/\\>`, flags);
}

export function extractEmotionTag(text: string): {
  cleanedText: string;
  emotion: EmotionTag | null;
} {
  const matches = Array.from(text.matchAll(createEmotionTagRegex("gi")));
  const emotion = matches.length > 0 ? (matches[matches.length - 1][1].toLowerCase() as EmotionTag) : null;

  return {
    cleanedText: text.replace(createEmotionTagRegex("gi"), ""),
    emotion
  };
}

export function stripEmotionTags(text: string): string {
  return text.replace(createEmotionTagRegex("gi"), "");
}

export interface EmotionTagStripper {
  push: (delta: string) => string;
  flush: () => string;
}

export function createEmotionTagStripper(): EmotionTagStripper {
  let pending = "";

  return {
    push: (delta: string) => {
      const combined = pending + delta;
      let visible = combined;
      pending = "";

      const lastLessThan = combined.lastIndexOf("<");
      if (lastLessThan >= 0 && combined.indexOf(">", lastLessThan) === -1) {
        visible = combined.slice(0, lastLessThan);
        pending = combined.slice(lastLessThan);
      }

      return stripEmotionTags(visible);
    },
    flush: () => {
      const tail = pending;
      pending = "";
      return stripEmotionTags(tail);
    }
  };
}
