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

const MAX_QUERY_TERMS = 60;

export interface QueryTerm {
  value: string;
  weight: number;
}

function isCjkChar(char: string): boolean {
  return /[\u3400-\u9fff]/.test(char);
}

function normalizeText(text: string): string {
  return text.replace(/[，。！？、,.!?;:()[\]{}"“”‘’`~]/g, " ").replace(/\s+/g, " ").trim();
}

function extractEnglishTerms(text: string): QueryTerm[] {
  const matches = normalizeText(text).match(/[a-z0-9][a-z0-9_-]{1,23}/gi) ?? [];
  const output: QueryTerm[] = [];
  for (const match of matches) {
    const value = match.trim().toLowerCase();
    if (value.length < 2 || STOP_WORDS.has(value)) {
      continue;
    }
    output.push({
      value,
      weight: 1
    });
  }
  return output;
}

function extractChineseNgrams(text: string): QueryTerm[] {
  const segments = normalizeText(text)
    .split(" ")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .flatMap((segment) => segment.split(/[^\u3400-\u9fff]+/g))
    .map((segment) => segment.trim())
    .filter(Boolean);

  const weighted = new Map<string, QueryTerm>();
  for (const segment of segments) {
    const chars = [...segment].filter((char) => isCjkChar(char));
    if (chars.length < 2) {
      continue;
    }

    for (const gramSize of [4, 3, 2]) {
      if (chars.length < gramSize) {
        continue;
      }
      for (let index = 0; index <= chars.length - gramSize; index += 1) {
        const value = chars.slice(index, index + gramSize).join("");
        if (STOP_WORDS.has(value)) {
          continue;
        }
        const priorityBoost = gramSize === 4 || index === 0 || index + gramSize === chars.length ? 0.1 : 0;
        const weight = 0.5 + priorityBoost;
        const existing = weighted.get(value);
        if (!existing || existing.weight < weight) {
          weighted.set(value, {
            value,
            weight
          });
        }
      }
    }
  }

  return [...weighted.values()].sort((a, b) => b.weight - a.weight || b.value.length - a.value.length);
}

export function extractQueryTerms(texts: string[]): QueryTerm[] {
  const deduped = new Map<string, QueryTerm>();
  for (const text of texts.slice(-3)) {
    for (const term of [...extractEnglishTerms(text), ...extractChineseNgrams(text)]) {
      const existing = deduped.get(term.value);
      if (!existing || existing.weight < term.weight) {
        deduped.set(term.value, term);
      }
      if (deduped.size >= MAX_QUERY_TERMS) {
        break;
      }
    }
    if (deduped.size >= MAX_QUERY_TERMS) {
      break;
    }
  }
  return [...deduped.values()].slice(0, MAX_QUERY_TERMS);
}

export function matchFacts(
  facts: Fact[],
  terms: QueryTerm[],
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
        if (haystack.includes(term.value)) {
          termHits += term.weight;
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
  terms: QueryTerm[],
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
        if (haystack.includes(term.value)) {
          termHits += term.weight;
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
