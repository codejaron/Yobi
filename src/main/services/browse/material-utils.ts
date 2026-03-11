import type { BrowseTopComment } from "@shared/types";

const NOISE_PATTERNS: RegExp[] = [
  /^(nice|漂亮|好看|厉害|牛|666|支持|nb|卧槽)$/i,
  /^(哈哈+|hhh+|233+|awsl)$/i,
  /^前排$/,
  /^打卡$/,
  /^来了$/
];

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[\u200b\u200c\u200d]/g, "").trim();
}

function isNoiseComment(text: string): boolean {
  if (text.length < 4) {
    return true;
  }

  return NOISE_PATTERNS.some((pattern) => pattern.test(text));
}

export function selectTopComments(
  comments: Array<{ text: string; likes: number }>,
  limit = 5
): BrowseTopComment[] {
  const deduped = new Map<string, number>();

  for (const item of comments) {
    const text = normalizeText(item.text);
    if (!text || isNoiseComment(text)) {
      continue;
    }

    const likes = Number.isFinite(item.likes) ? Math.max(0, Math.floor(item.likes)) : 0;
    const previous = deduped.get(text) ?? 0;
    deduped.set(text, Math.max(previous, likes));
    if (deduped.size >= 80) {
      break;
    }
  }

  return [...deduped.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, Math.min(10, limit)))
    .map(([text, likes]): BrowseTopComment => ({
      text,
      likes
    }));
}
