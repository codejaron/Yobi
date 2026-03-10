import type { BilibiliVideoItem, BrowseCandidateSignal } from "./types";

export interface AutoFollowLimits {
  minIntervalMs: number;
  maxPerDay: number;
  maxPerWeek: number;
  maxTotal: number;
}

export function selectSyncItems(input: {
  feedItems: BilibiliVideoItem[];
  hotItems: BilibiliVideoItem[];
  maxFeed?: number;
  maxHot?: number;
}): BilibiliVideoItem[] {
  const maxFeed = Math.max(0, input.maxFeed ?? 6);
  const maxHot = Math.max(0, input.maxHot ?? 4);
  const picked: BilibiliVideoItem[] = [];
  const seen = new Set<string>();

  for (const item of input.feedItems) {
    if (!item.bvid || seen.has(item.bvid)) {
      continue;
    }
    seen.add(item.bvid);
    picked.push(item);
    if (picked.filter((entry) => entry.source === "feed").length >= maxFeed) {
      break;
    }
  }

  let hotPicked = 0;
  for (const item of input.hotItems) {
    if (!item.bvid || seen.has(item.bvid)) {
      continue;
    }
    seen.add(item.bvid);
    picked.push(item);
    hotPicked += 1;
    if (hotPicked >= maxHot) {
      break;
    }
  }

  return picked;
}

export function candidateMetrics(candidate: BrowseCandidateSignal): {
  syncCount: number;
  uniqueVideoCount: number;
  hasSearchSupport: boolean;
} {
  return {
    syncCount: new Set(candidate.syncKeys).size,
    uniqueVideoCount: new Set(candidate.videos.map((video) => video.bvid)).size,
    hasSearchSupport: candidate.searchKeywords.length > 0 || candidate.videos.some((video) => video.source === "search")
  };
}

export function canAutoFollowCandidate(input: {
  candidate: BrowseCandidateSignal;
  nowMs: number;
  lastAutoFollowAt: string | null;
  autoFollowTodayCount: number;
  weekFollowCount: number;
  totalFollowCount: number;
  limits: AutoFollowLimits;
}): boolean {
  const metrics = candidateMetrics(input.candidate);
  if (metrics.syncCount < 2 || metrics.uniqueVideoCount < 2) {
    return false;
  }
  if (input.autoFollowTodayCount >= input.limits.maxPerDay) {
    return false;
  }
  if (input.weekFollowCount >= input.limits.maxPerWeek) {
    return false;
  }
  if (input.totalFollowCount >= input.limits.maxTotal) {
    return false;
  }
  if (input.lastAutoFollowAt) {
    const elapsed = input.nowMs - new Date(input.lastAutoFollowAt).getTime();
    if (Number.isFinite(elapsed) && elapsed < input.limits.minIntervalMs) {
      return false;
    }
  }
  return true;
}

export function describeAutoFollowReason(input: {
  candidate: BrowseCandidateSignal;
  coldStart: boolean;
}): string {
  if (input.coldStart) {
    return "冷启动补足";
  }
  return input.candidate.searchKeywords.length > 0 ? "偏好扩展" : "重复出现";
}
