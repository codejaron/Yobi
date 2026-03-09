import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { CompanionPaths } from "../storage/paths.js";
import { TokenStatsStore, localDayKey } from "../services/token/token-stats-store.js";

async function createTempPaths(): Promise<{ dir: string; paths: CompanionPaths }> {
  const dir = await mkdtemp(path.join(tmpdir(), "yobi-token-store-"));
  const paths = new CompanionPaths(dir);
  paths.ensureLayout();
  return {
    dir,
    paths
  };
}

test("TokenStatsStore: should aggregate records into local day bucket", async () => {
  const { dir, paths } = await createTempPaths();
  const store = new TokenStatsStore(paths);

  try {
    const now = new Date();
    await store.record({
      source: "chat:console",
      tokens: 120,
      estimatedTokens: 0,
      timestamp: now
    });
    await store.record({
      source: "background:fact-extraction",
      tokens: 40,
      estimatedTokens: 40,
      timestamp: now
    });
    await store.record({
      source: "background:proactive-push",
      tokens: 10,
      estimatedTokens: 0,
      timestamp: now
    });

    const status = await store.getStatus();
    assert.equal(status.days.length, 1);
    assert.equal(status.days[0]?.dayKey, localDayKey(now));
    assert.equal(status.days[0]?.totalTokens, 170);
    assert.equal(status.days[0]?.estimatedTokens, 40);
    assert.equal(status.days[0]?.bySource["chat:console"]?.tokens, 120);
    assert.equal(status.days[0]?.bySource["background:fact-extraction"]?.estimatedTokens, 40);
    assert.equal(status.days[0]?.bySource["background:proactive-push"]?.tokens, 10);
    assert.equal(typeof status.days[0]?.timeZone, "string");
    assert.equal(Number.isFinite(status.days[0]?.tzOffsetMinutes), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TokenStatsStore: should split records by local date", async () => {
  const { dir, paths } = await createTempPaths();
  const store = new TokenStatsStore(paths);

  try {
    const day1 = new Date(2026, 2, 1, 23, 55, 0);
    const day2 = new Date(2026, 2, 2, 0, 5, 0);

    await store.record({
      source: "chat:telegram",
      tokens: 33,
      estimatedTokens: 0,
      timestamp: day1
    });
    await store.record({
      source: "chat:telegram",
      tokens: 22,
      estimatedTokens: 0,
      timestamp: day2
    });

    const status = await store.getStatus();
    const dayKeys = status.days.map((item) => item.dayKey);

    assert.equal(dayKeys.includes(localDayKey(day1)), true);
    assert.equal(dayKeys.includes(localDayKey(day2)), true);
    assert.equal(status.days.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TokenStatsStore: should trim stale buckets to retention limit", async () => {
  const { dir, paths } = await createTempPaths();

  try {
    const rawState = {
      version: 1,
      retentionDays: 3,
      days: {
        "2026-03-01": {
          dayKey: "2026-03-01",
          timeZone: "Asia/Shanghai",
          tzOffsetMinutes: 480,
          totalTokens: 10,
          estimatedTokens: 0,
          bySource: {
            "chat:console": {
              tokens: 10,
              estimatedTokens: 0
            }
          },
          updatedAt: "2026-03-01T12:00:00.000Z"
        },
        "2026-03-02": {
          dayKey: "2026-03-02",
          timeZone: "Asia/Shanghai",
          tzOffsetMinutes: 480,
          totalTokens: 20,
          estimatedTokens: 0,
          bySource: {
            "chat:console": {
              tokens: 20,
              estimatedTokens: 0
            }
          },
          updatedAt: "2026-03-02T12:00:00.000Z"
        },
        "2026-03-03": {
          dayKey: "2026-03-03",
          timeZone: "Asia/Shanghai",
          tzOffsetMinutes: 480,
          totalTokens: 30,
          estimatedTokens: 0,
          bySource: {
            "chat:console": {
              tokens: 30,
              estimatedTokens: 0
            }
          },
          updatedAt: "2026-03-03T12:00:00.000Z"
        },
        "2026-03-04": {
          dayKey: "2026-03-04",
          timeZone: "Asia/Shanghai",
          tzOffsetMinutes: 480,
          totalTokens: 40,
          estimatedTokens: 0,
          bySource: {
            "chat:console": {
              tokens: 40,
              estimatedTokens: 0
            }
          },
          updatedAt: "2026-03-04T12:00:00.000Z"
        }
      }
    };

    await writeFile(paths.tokenStatsStatePath, `${JSON.stringify(rawState, null, 2)}\n`, "utf8");

    const store = new TokenStatsStore(paths);
    const status = await store.getStatus();

    assert.equal(status.retentionDays, 3);
    assert.equal(status.days.length, 3);
    assert.equal(status.days[0]?.dayKey, "2026-03-02");
    assert.equal(status.days[2]?.dayKey, "2026-03-04");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
