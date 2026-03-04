import type { Episode, Fact } from "@shared/types";

const STOP_WORDS = new Set([
  "的",
  "了",
  "吗",
  "呢",
  "啊",
  "呀",
  "哦",
  "我",
  "你",
  "他",
  "她",
  "它",
  "我们",
  "你们",
  "他们",
  "是",
  "在",
  "有",
  "和",
  "就",
  "都",
  "也",
  "要",
  "想",
  "会",
  "不",
  "没"
]);

export function extractQueryTerms(texts: string[]): string[] {
  const output = new Set<string>();
  for (const text of texts.slice(-3)) {
    const normalized = text.replace(/[，。！？、,.!?;:()[\]{}"“”‘’`~]/g, " ").replace(/\s+/g, " ");
    const pieces = normalized.split(" ").map((piece) => piece.trim()).filter(Boolean);
    for (const piece of pieces) {
      if (piece.length < 2 || piece.length > 24 || STOP_WORDS.has(piece)) {
        continue;
      }
      output.add(piece.toLowerCase());
      if (output.size >= 40) {
        break;
      }
    }
    if (output.size >= 40) {
      break;
    }
  }
  return [...output];
}

export function matchFacts(
  facts: Fact[],
  terms: string[],
  limit = 20
): Array<{ fact: Fact; score: number }> {
  if (terms.length === 0 || facts.length === 0) {
    return [];
  }

  const scored = facts
    .map((fact) => {
      const haystack = `${fact.entity} ${fact.key} ${fact.value}`.toLowerCase();
      let termHits = 0;
      for (const term of terms) {
        if (haystack.includes(term)) {
          termHits += 1;
        }
      }
      if (termHits === 0) {
        return null;
      }

      const recencyMs = Date.now() - new Date(fact.updated_at).getTime();
      const recencyScore = Number.isFinite(recencyMs) ? Math.max(0, 1 - recencyMs / (90 * 24 * 3600 * 1000)) : 0;
      const score = termHits * 1.5 + fact.confidence + recencyScore;
      return {
        fact,
        score
      };
    })
    .filter((item): item is { fact: Fact; score: number } => item !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));

  return scored;
}

export function matchEpisodes(
  episodes: Episode[],
  terms: string[],
  limit = 8
): Array<{ episode: Episode; score: number }> {
  if (terms.length === 0 || episodes.length === 0) {
    return [];
  }
  const scored = episodes
    .map((episode) => {
      const haystack = `${episode.summary} ${episode.unresolved.join(" ")}`.toLowerCase();
      let termHits = 0;
      for (const term of terms) {
        if (haystack.includes(term)) {
          termHits += 1;
        }
      }
      if (termHits === 0) {
        return null;
      }
      const recencyMs = Date.now() - new Date(episode.updated_at).getTime();
      const recencyScore = Number.isFinite(recencyMs) ? Math.max(0, 1 - recencyMs / (30 * 24 * 3600 * 1000)) : 0;
      const score = termHits * 1.5 + episode.significance + recencyScore;
      return {
        episode,
        score
      };
    })
    .filter((item): item is { episode: Episode; score: number } => item !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
  return scored;
}
