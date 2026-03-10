import test from "node:test";
import assert from "node:assert/strict";
import { canAutoFollowCandidate, candidateMetrics, selectSyncItems } from "../services/browse/sync-logic.js";
import type { BilibiliVideoItem, BrowseCandidateSignal } from "../services/browse/types.js";

function video(input: Partial<BilibiliVideoItem> & Pick<BilibiliVideoItem, "bvid" | "title" | "ownerName" | "source" | "url">): BilibiliVideoItem {
  return {
    tags: [],
    ...input
  };
}

function candidate(input?: Partial<BrowseCandidateSignal>): BrowseCandidateSignal {
  return {
    ownerMid: "1001",
    ownerName: "测试 UP",
    syncKeys: ["2026-03-01T00:00:00.000Z", "2026-03-02T00:00:00.000Z"],
    searchKeywords: [],
    videos: [
      {
        bvid: "BV1",
        seenAt: "2026-03-01T00:00:00.000Z",
        source: "hot"
      },
      {
        bvid: "BV2",
        seenAt: "2026-03-02T00:00:00.000Z",
        source: "search"
      }
    ],
    ...input
  };
}

test("selectSyncItems: should prefer feed and fill with hot without duplicates", () => {
  const selected = selectSyncItems({
    feedItems: [
      video({ bvid: "BV1", title: "feed-1", ownerName: "A", source: "feed", url: "u1" }),
      video({ bvid: "BV2", title: "feed-2", ownerName: "B", source: "feed", url: "u2" })
    ],
    hotItems: [
      video({ bvid: "BV2", title: "dup", ownerName: "B", source: "hot", url: "u2" }),
      video({ bvid: "BV3", title: "hot-1", ownerName: "C", source: "hot", url: "u3" }),
      video({ bvid: "BV4", title: "hot-2", ownerName: "D", source: "hot", url: "u4" })
    ],
    maxFeed: 2,
    maxHot: 2
  });

  assert.deepEqual(
    selected.map((item) => item.bvid),
    ["BV1", "BV2", "BV3", "BV4"]
  );
});

test("candidateMetrics: should count syncs and unique videos", () => {
  const metrics = candidateMetrics(candidate());
  assert.equal(metrics.syncCount, 2);
  assert.equal(metrics.uniqueVideoCount, 2);
  assert.equal(metrics.hasSearchSupport, true);
});

test("canAutoFollowCandidate: should block when cadence limit is not met", () => {
  const allowed = canAutoFollowCandidate({
    candidate: candidate(),
    nowMs: new Date("2026-03-03T06:00:00.000Z").getTime(),
    lastAutoFollowAt: "2026-03-03T00:00:00.000Z",
    autoFollowTodayCount: 0,
    weekFollowCount: 0,
    totalFollowCount: 0,
    limits: {
      minIntervalMs: 12 * 60 * 60 * 1000,
      maxPerDay: 2,
      maxPerWeek: 8,
      maxTotal: 80
    }
  });

  assert.equal(allowed, false);
});

test("canAutoFollowCandidate: should pass when candidate is mature and within limits", () => {
  const allowed = canAutoFollowCandidate({
    candidate: candidate(),
    nowMs: new Date("2026-03-03T18:00:00.000Z").getTime(),
    lastAutoFollowAt: "2026-03-03T00:00:00.000Z",
    autoFollowTodayCount: 1,
    weekFollowCount: 3,
    totalFollowCount: 10,
    limits: {
      minIntervalMs: 12 * 60 * 60 * 1000,
      maxPerDay: 2,
      maxPerWeek: 8,
      maxTotal: 80
    }
  });

  assert.equal(allowed, true);
});
