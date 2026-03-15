import { OPENFEELZ_EMOTION_LABELS, type RealtimeEmotionalSignals } from "@shared/types";

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
const SIGNALS_TAG_NAME = "signals";
const SIGNALS_REQUIRED_KEYS = [
  "emotion_label",
  "intensity",
  "engagement",
  "trust_delta"
] as const;
const SIGNALS_ALLOWED_LABELS = new Set<string>(OPENFEELZ_EMOTION_LABELS);

function createEmotionTagRegex(flags: string): RegExp {
  return new RegExp(`<e:${EMOTION_PATTERN}\\s*\\/\\>`, flags);
}

function createEmotionTagToEndRegex(flags: string): RegExp {
  return new RegExp(`<e:${EMOTION_PATTERN}[^>]*$`, flags);
}

function createSignalsTagRegex(flags: string): RegExp {
  return new RegExp(`<${SIGNALS_TAG_NAME}\\b[^>]*\\/\\>`, flags);
}

function createSignalsTagToEndRegex(flags: string): RegExp {
  return new RegExp(`<${SIGNALS_TAG_NAME}\\b[^>]*$`, flags);
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
  const knownPrefixes = ["<think", "</think", "<e:", `<${SIGNALS_TAG_NAME}`, `</${SIGNALS_TAG_NAME}`];
  const isKnownPrefix = knownPrefixes.some((prefix) => prefix.startsWith(normalizedTail));
  return isKnownPrefix ? text.slice(0, lastLessThan) : text;
}

function parseTagAttributes(tagText: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const attributePattern = /([a-z_]+)\s*=\s*("([^"]*)"|'([^']*)')/gi;
  const matches = Array.from(tagText.matchAll(attributePattern));
  for (const match of matches) {
    const key = match[1]?.toLowerCase().trim();
    if (!key) {
      continue;
    }
    const value = (match[3] ?? match[4] ?? "").trim();
    attributes.set(key, value);
  }
  return attributes;
}

function parseSignalNumber(raw: string | undefined): number | null {
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function parseSignalsTag(tagText: string): RealtimeEmotionalSignals | null {
  const attributes = parseTagAttributes(tagText);
  if (attributes.size !== SIGNALS_REQUIRED_KEYS.length) {
    return null;
  }
  for (const key of SIGNALS_REQUIRED_KEYS) {
    if (!attributes.has(key)) {
      return null;
    }
  }
  for (const key of attributes.keys()) {
    if (!SIGNALS_REQUIRED_KEYS.includes(key as (typeof SIGNALS_REQUIRED_KEYS)[number])) {
      return null;
    }
  }

  const emotionLabel = attributes.get("emotion_label")?.trim().toLowerCase();
  if (!emotionLabel || !SIGNALS_ALLOWED_LABELS.has(emotionLabel)) {
    return null;
  }

  const intensity = parseSignalNumber(attributes.get("intensity"));
  if (intensity === null) {
    return null;
  }

  const engagement = parseSignalNumber(attributes.get("engagement"));
  if (engagement === null) {
    return null;
  }

  const trustDelta = parseSignalNumber(attributes.get("trust_delta"));
  if (trustDelta === null) {
    return null;
  }

  return {
    emotion_label: emotionLabel,
    intensity: Math.max(0, Math.min(1, intensity)),
    engagement: Math.max(0, Math.min(1, engagement)),
    trust_delta: Math.max(-0.3, Math.min(0.3, trustDelta))
  };
}

function stripHiddenTags(text: string): string {
  const withoutThink = text
    .replace(createThinkBlockRegex("gi"), "")
    .replace(createThinkOpenToEndRegex("gi"), "")
    .replace(createThinkCloseRegex("gi"), "")
    .replace(createThinkCloseToEndRegex("gi"), "");

  return stripPotentialTrailingHiddenTag(
    withoutThink
      .replace(createEmotionTagRegex("gi"), "")
      .replace(createEmotionTagToEndRegex("gi"), "")
      .replace(createSignalsTagRegex("gi"), "")
      .replace(createSignalsTagToEndRegex("gi"), "")
  );
}

export function extractEmotionTag(text: string): {
  cleanedText: string;
  emotion: EmotionTag | null;
  signals: RealtimeEmotionalSignals | null;
} {
  const withoutThink = text
    .replace(createThinkBlockRegex("gi"), "")
    .replace(createThinkOpenToEndRegex("gi"), "")
    .replace(createThinkCloseRegex("gi"), "")
    .replace(createThinkCloseToEndRegex("gi"), "");

  const matches = Array.from(withoutThink.matchAll(createEmotionTagRegex("gi")));
  const emotion = matches.length > 0 ? (matches[matches.length - 1][1].toLowerCase() as EmotionTag) : null;
  const signalMatches = Array.from(withoutThink.matchAll(createSignalsTagRegex("gi")));
  const signalTag = signalMatches.length > 0 ? signalMatches[signalMatches.length - 1][0] : "";
  const signals = signalTag ? parseSignalsTag(signalTag) : null;

  return {
    cleanedText: stripHiddenTags(withoutThink),
    emotion,
    signals
  };
}

export function extractRawSignalsTag(text: string): string {
  const withoutThink = text
    .replace(createThinkBlockRegex("gi"), "")
    .replace(createThinkOpenToEndRegex("gi"), "")
    .replace(createThinkCloseRegex("gi"), "")
    .replace(createThinkCloseToEndRegex("gi"), "");

  const signalMatches = Array.from(withoutThink.matchAll(createSignalsTagRegex("gi")));
  return signalMatches.length > 0 ? signalMatches[signalMatches.length - 1][0] ?? "" : "";
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
