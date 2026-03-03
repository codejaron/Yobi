import type { InterestProfile } from "@shared/types";
import type { BilibiliVideoItem, MatchedCandidate } from "./types";

interface MatchInput {
  feedItems: BilibiliVideoItem[];
  hotItems: BilibiliVideoItem[];
  interests: InterestProfile;
  eventFreshWindowMs: number;
}

function normalizeText(value: string): string {
  return value.toLowerCase();
}

function uniqueTerms(values: string[]): string[] {
  const deduped = new Set<string>();
  for (const value of values) {
    const term = value.trim();
    if (!term) {
      continue;
    }
    deduped.add(term);
  }
  return [...deduped];
}

function toSearchSpace(item: BilibiliVideoItem): string {
  return [item.title, item.ownerName, item.description ?? "", ...item.tags]
    .join("\n")
    .toLowerCase();
}

export class InterestMatcher {
  match(input: MatchInput): MatchedCandidate[] {
    const watchedCandidates = [...input.feedItems, ...input.hotItems];
    if (watchedCandidates.length === 0) {
      return [];
    }

    const interests = input.interests;
    const includeTerms = uniqueTerms([
      ...interests.games,
      ...interests.creators,
      ...interests.domains,
      ...interests.keywords
    ]).map(normalizeText);
    const dislikeTerms = uniqueTerms(interests.dislikes).map(normalizeText);
    const coldStart = includeTerms.length < 3;
    const nowMs = Date.now();

    const scored: MatchedCandidate[] = [];

    for (const item of watchedCandidates) {
      const searchSpace = toSearchSpace(item);
      const matched: string[] = [];
      let score = item.source === "feed" ? 6 : 2;

      for (const term of includeTerms) {
        if (!term) {
          continue;
        }
        if (searchSpace.includes(term)) {
          score += 2;
          matched.push(term);
        }
      }

      for (const term of dislikeTerms) {
        if (!term) {
          continue;
        }
        if (searchSpace.includes(term)) {
          score -= 8;
          matched.push(`!${term}`);
        }
      }

      const freshEvent =
        item.source === "feed" &&
        typeof item.pubTs === "number" &&
        nowMs - item.pubTs * 1000 <= input.eventFreshWindowMs;

      if (freshEvent) {
        score += 8;
      }

      const hasPositiveMatch = matched.some((term) => !term.startsWith("!"));

      if (!coldStart && item.source === "hot" && !hasPositiveMatch) {
        continue;
      }

      if (score <= 0) {
        continue;
      }

      scored.push({
        item,
        score,
        matches: matched,
        isEvent: freshEvent
      });
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      const pubA = a.item.pubTs ?? 0;
      const pubB = b.item.pubTs ?? 0;
      if (pubB !== pubA) {
        return pubB - pubA;
      }

      const viewA = a.item.view ?? 0;
      const viewB = b.item.view ?? 0;
      return viewB - viewA;
    });

    const deduped: MatchedCandidate[] = [];
    const seen = new Set<string>();

    for (const candidate of scored) {
      if (seen.has(candidate.item.bvid)) {
        continue;
      }
      seen.add(candidate.item.bvid);
      deduped.push(candidate);
      if (deduped.length >= 30) {
        break;
      }
    }

    return deduped;
  }
}
