import test from "node:test";
import assert from "node:assert/strict";
import type { TokenStatsStatus } from "@shared/types";
import { aggregateTokenStats } from "../../renderer/pages/dashboard/token-aggregate.js";

function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayOffset(base: Date, offset: number): string {
  const target = new Date(base);
  target.setDate(base.getDate() + offset);
  return localDayKey(target);
}

test("aggregateTokenStats: should aggregate today and 7-day source breakdown", () => {
  const now = new Date(2026, 2, 10, 12, 0, 0);

  const status: TokenStatsStatus = {
    retentionDays: 90,
    lastUpdatedAt: "2026-03-10T04:00:00.000Z",
    days: [
      {
        dayKey: dayOffset(now, 0),
        timeZone: "Asia/Shanghai",
        tzOffsetMinutes: 480,
        totalTokens: 160,
        estimatedTokens: 20,
        bySource: {
          "chat:console": {
            tokens: 100,
            estimatedTokens: 0
          },
          "background:fact-extraction": {
            tokens: 30,
            estimatedTokens: 0
          },
          "background:daily-summary": {
            tokens: 8,
            estimatedTokens: 6
          },
          "background:profile-update": {
            tokens: 6,
            estimatedTokens: 4
          },
          "background:reflection": {
            tokens: 9,
            estimatedTokens: 8
          },
          "background:proactive-push": {
            tokens: 7,
            estimatedTokens: 2
          }
        },
        updatedAt: "2026-03-10T04:00:00.000Z"
      },
      {
        dayKey: dayOffset(now, -6),
        timeZone: "Asia/Shanghai",
        tzOffsetMinutes: 480,
        totalTokens: 70,
        estimatedTokens: 0,
        bySource: {
          "chat:qq": {
            tokens: 70,
            estimatedTokens: 0
          }
        },
        updatedAt: "2026-03-04T04:00:00.000Z"
      },
      {
        dayKey: dayOffset(now, -18),
        timeZone: "Asia/Shanghai",
        tzOffsetMinutes: 480,
        totalTokens: 300,
        estimatedTokens: 0,
        bySource: {
          "chat:telegram": {
            tokens: 300,
            estimatedTokens: 0
          }
        },
        updatedAt: "2026-02-20T04:00:00.000Z"
      }
    ]
  };

  const today = aggregateTokenStats(status, {
    period: "today",
    narrowViewport: false,
    now
  });

  assert.equal(today.totalTokens, 160);
  assert.equal(today.estimatedTokens, 20);
  assert.equal(today.sourceTotals.chat.tokens, 100);
  assert.equal(today.sourceTotals.background.tokens, 60);
  assert.equal(today.backgroundDetails[0]?.label, "事实提取");
  assert.equal(today.backgroundDetails[0]?.tokens, 30);
  assert.equal(today.backgroundDetails[1]?.label, "每日总结");
  assert.equal(today.backgroundDetails[1]?.tokens, 8);
  assert.equal(today.backgroundDetails[2]?.label, "画像更新");
  assert.equal(today.backgroundDetails[2]?.tokens, 6);
  assert.equal(today.backgroundDetails[3]?.label, "反思");
  assert.equal(today.backgroundDetails[3]?.tokens, 9);
  assert.equal(today.backgroundDetails[4]?.label, "主动推送");
  assert.equal(today.backgroundDetails[4]?.tokens, 7);
  assert.equal(today.backgroundDetails.length, 5);

  const sevenDays = aggregateTokenStats(status, {
    period: "7d",
    narrowViewport: false,
    now
  });

  assert.equal(sevenDays.totalTokens, 230);
  assert.equal(sevenDays.sourceTotals.chat.tokens, 170);
  assert.equal(sevenDays.sourceTotals.background.tokens, 60);
  assert.equal(sevenDays.trendWindowDays, 7);
  assert.equal(sevenDays.trendBars.length, 7);
});

test("aggregateTokenStats: should downgrade 30-day trend on narrow viewport", () => {
  const now = new Date(2026, 2, 10, 12, 0, 0);

  const status: TokenStatsStatus = {
    retentionDays: 90,
    lastUpdatedAt: "2026-03-10T04:00:00.000Z",
    days: [
      {
        dayKey: dayOffset(now, 0),
        timeZone: "Asia/Shanghai",
        tzOffsetMinutes: 480,
        totalTokens: 120,
        estimatedTokens: 0,
        bySource: {
          "chat:console": {
            tokens: 120,
            estimatedTokens: 0
          }
        },
        updatedAt: "2026-03-10T04:00:00.000Z"
      },
      {
        dayKey: dayOffset(now, -20),
        timeZone: "Asia/Shanghai",
        tzOffsetMinutes: 480,
        totalTokens: 80,
        estimatedTokens: 0,
        bySource: {
          "background:proactive-push": {
            tokens: 80,
            estimatedTokens: 0
          }
        },
        updatedAt: "2026-02-18T04:00:00.000Z"
      }
    ]
  };

  const result = aggregateTokenStats(status, {
    period: "30d",
    narrowViewport: true,
    now
  });

  assert.equal(result.totalTokens, 200);
  assert.equal(result.trendDowngradedOnMobile, true);
  assert.equal(result.trendWindowDays, 7);
  assert.equal(result.trendBars.length, 7);
  assert.equal(result.backgroundDetails[4]?.tokens, 80);
});
