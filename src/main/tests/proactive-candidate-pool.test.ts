import test from "node:test";
import assert from "node:assert/strict";
import { buildCandidatePool } from "../services/proactive-candidates.js";

function isoOffset(minutesOffset: number): string {
  return new Date(Date.now() + minutesOffset * 60 * 1000).toISOString();
}

test("buildCandidatePool: should remove event topic when event sharing is blocked", () => {
  const result = buildCandidatePool({
    topics: [
      {
        id: "topic-event",
        source: "browse:event",
        text: "影视飓风更新了",
        createdAt: isoOffset(-30)
      },
      {
        id: "topic-digest",
        source: "browse:digest",
        text: "普通摘要",
        createdAt: isoOffset(-15)
      }
    ],
    allowEventShare: false,
    eventFreshWindowMs: 2 * 60 * 60 * 1000
  });

  assert.equal(result.candidates.some((item) => item.source === "browse:event"), false);
  assert.equal(result.candidates.some((item) => item.id === "topic-digest"), true);
  assert.equal(result.eventCandidates.length, 0);
});

test("buildCandidatePool: should keep fresh event topics when sharing allowed", () => {
  const result = buildCandidatePool({
    topics: [
      {
        id: "topic-event-fresh",
        source: "browse:event",
        text: "老番茄新视频",
        createdAt: isoOffset(-10)
      },
      {
        id: "topic-text-only",
        source: "recall",
        text: "你前几天说的吉他练习怎么样了",
        createdAt: isoOffset(-5)
      }
    ],
    allowEventShare: true,
    eventFreshWindowMs: 2 * 60 * 60 * 1000
  });

  assert.equal(result.candidates.length, 2);
  assert.equal(result.eventCandidates.length, 1);
  assert.equal(result.eventCandidates[0]?.id, "topic-event-fresh");
  assert.equal(result.candidates.some((item) => item.id === "topic-text-only"), true);
});

test("buildCandidatePool: should discard stale event topics", () => {
  const result = buildCandidatePool({
    topics: [
      {
        id: "topic-event-old",
        source: "browse:event",
        text: "过期事件",
        createdAt: isoOffset(-6 * 60)
      },
      {
        id: "topic-digest",
        source: "browse:digest",
        text: "仍然可用的摘要",
        createdAt: isoOffset(-20)
      }
    ],
    allowEventShare: true,
    eventFreshWindowMs: 2 * 60 * 60 * 1000
  });

  assert.equal(result.candidates.some((item) => item.id === "topic-event-old"), false);
  assert.equal(result.candidates.some((item) => item.id === "topic-digest"), true);
});
