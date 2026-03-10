import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { CompanionPaths } from "../storage/paths.js";
import { YobiMemory } from "../memory/setup.js";
import { KernelEngine } from "../kernel/engine.js";
import { StateStore } from "../kernel/state-store.js";
import { DailyEpisodeTaskHandler } from "../kernel/task-handlers.js";
import { assembleContext } from "../memory-v2/context-assembler.js";
import {
  DEFAULT_CONFIG,
  DEFAULT_KERNEL_STATE,
  DEFAULT_USER_PROFILE,
  type AppConfig,
  type PendingTask
} from "@shared/types";

function cloneConfig(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

async function createTempPaths(prefix: string): Promise<CompanionPaths> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const paths = new CompanionPaths(baseDir);
  paths.ensureLayout();
  return paths;
}

function withFixedNow<T>(fixedDate: Date, run: () => Promise<T> | T): Promise<T> | T {
  const RealDate = Date;
  const fixedTime = fixedDate.getTime();
  class MockDate extends RealDate {
    constructor(value?: string | number | Date) {
      if (arguments.length === 0) {
        super(fixedTime);
        return;
      }
      super(value as string | number | Date);
    }

    static now(): number {
      return fixedTime;
    }

    static parse(value: string): number {
      return RealDate.parse(value);
    }

    static UTC(...args: Parameters<typeof RealDate.UTC>): number {
      return RealDate.UTC(...args);
    }
  }

  globalThis.Date = MockDate as DateConstructor;
  const finalize = () => {
    globalThis.Date = RealDate;
  };

  try {
    const result = run();
    if (result && typeof (result as Promise<T>).finally === "function") {
      return (result as Promise<T>).finally(finalize);
    }
    finalize();
    return result;
  } catch (error) {
    finalize();
    throw error;
  }
}

test("listHistory: returns newest window in chronological order", async () => {
  const paths = await createTempPaths("yobi-history-");
  try {
    const config = cloneConfig();
    const memory = new YobiMemory(paths, () => config);
    await memory.init();

    for (const text of ["第一条", "第二条", "第三条", "第四条"]) {
      await memory.rememberMessage({
        threadId: "main",
        resourceId: "main",
        role: "user",
        text,
        metadata: { channel: "console" }
      });
    }

    const recent = await memory.listHistory({
      threadId: "main",
      resourceId: "main",
      limit: 2,
      offset: 0
    });
    const offsetRecent = await memory.listHistory({
      threadId: "main",
      resourceId: "main",
      limit: 2,
      offset: 1
    });

    assert.deepEqual(recent.map((item) => item.text), ["第三条", "第四条"]);
    assert.deepEqual(offsetRecent.map((item) => item.text), ["第二条", "第三条"]);
  } finally {
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});

test("buffer compaction: removed messages persist into unprocessed queue", async () => {
  const paths = await createTempPaths("yobi-compaction-");
  try {
    const config = cloneConfig();
    config.kernel.buffer.maxMessages = 20;
    config.kernel.buffer.lowWatermark = 10;
    const memory = new YobiMemory(paths, () => config);
    await memory.init();

    for (let index = 1; index <= 21; index += 1) {
      await memory.rememberMessage({
        threadId: "main",
        resourceId: "main",
        role: "user",
        text: `消息-${index}`,
        metadata: { channel: "console" }
      });
    }

    const pending = await memory.consumeUnprocessedBuffer();
    assert.equal(pending.length, 11);
    assert.equal(pending[0]?.text, "消息-1");
    assert.equal(pending[10]?.text, "消息-11");
  } finally {
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});

test("queuePendingBufferExtractions: marks buffered rows once and avoids duplicate claims", async () => {
  const paths = await createTempPaths("yobi-claim-");
  try {
    const config = cloneConfig();
    const memory = new YobiMemory(paths, () => config);
    await memory.init();

    for (const text of ["甲", "乙", "丙"]) {
      await memory.rememberMessage({
        threadId: "main",
        resourceId: "main",
        role: "user",
        text,
        metadata: { channel: "console" }
      });
    }

    const claimed = await memory.queuePendingBufferExtractions(3);
    const claimedAgain = await memory.queuePendingBufferExtractions(1);
    const buffer = await memory.listAllBufferMessages();

    assert.equal(claimed.length, 3);
    assert.equal(claimedAgain.length, 0);
    assert.ok(buffer.every((row) => row.extractionQueued === true));
  } finally {
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});

test("DailyEpisodeTaskHandler: uses payload dayKey and stores emotional context", async () => {
  const paths = await createTempPaths("yobi-episode-");
  try {
    const config = cloneConfig();
    const memory = new YobiMemory(paths, () => config);
    await memory.init();

    await memory.getBufferStore().append({
      role: "user",
      channel: "console",
      text: "昨天白天的内容",
      ts: new Date(2026, 2, 9, 11, 0, 0).toISOString()
    });
    await memory.getBufferStore().append({
      role: "assistant",
      channel: "console",
      text: "昨天的回复",
      ts: new Date(2026, 2, 9, 11, 5, 0).toISOString()
    });
    await memory.getBufferStore().append({
      role: "user",
      channel: "console",
      text: "今天的内容",
      ts: new Date(2026, 2, 10, 9, 0, 0).toISOString()
    });

    const workerCalls: Array<{ date: string; texts: string[] }> = [];
    const handler = new DailyEpisodeTaskHandler({
      paths,
      memory,
      getConfig: () => config,
      backgroundWorker: {
        runDailyEpisode: async (input: {
          date: string;
          dayItems: Array<{ role: string; text: string }>;
        }) => {
          workerCalls.push({ date: input.date, texts: input.dayItems.map((item) => item.text) });
          return {
            summary: "昨天总结",
            unresolved: ["还有后续"],
            significance: 0.8,
            user_mood: "tired",
            yobi_mood: "supportive"
          };
        }
      } as any,
      resourceId: "main",
      threadId: "main"
    });

    const task: PendingTask = {
      id: "task-1",
      type: "daily-episode",
      status: "pending",
      payload: { dayKey: "2026-03-09" },
      available_at: new Date().toISOString(),
      attempts: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    await handler.handle(task);

    const episodes = await memory.getEpisodesStore().getByDate("2026-03-09");
    assert.equal(workerCalls[0]?.date, "2026-03-09");
    assert.deepEqual(workerCalls[0]?.texts, ["昨天白天的内容", "昨天的回复"]);
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0]?.summary, "昨天总结");
    assert.equal(episodes[0]?.emotional_context.user_mood, "tired");
    assert.equal(episodes[0]?.emotional_context.yobi_mood, "supportive");
    assert.deepEqual(episodes[0]?.source_ranges, ["day:2026-03-09"]);
    assert.deepEqual(await memory.getEpisodesStore().getByDate("2026-03-10"), []);
  } finally {
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});

test("searchRelevantFacts: bm25-only fallback keeps lexical hit when vector is unavailable", async () => {
  const paths = await createTempPaths("yobi-bm25-rank-");
  try {
    const config = cloneConfig();
    config.memory.embedding.enabled = true;
    config.memory.embedding.modelId = "missing-model.gguf";
    const memory = new YobiMemory(paths, () => config);
    await memory.init();

    const changed = await memory.getFactsStore().applyOperations(
      [
        {
          action: "add",
          fact: {
            entity: "用户",
            key: "状态.直接",
            value: "最近很累",
            category: "event",
            confidence: 0.7,
            ttl_class: "active"
          }
        },
        {
          action: "add",
          fact: {
            entity: "用户",
            key: "状态.语义",
            value: "最近加班较多",
            category: "event",
            confidence: 0.9,
            ttl_class: "active"
          }
        }
      ],
      "test"
    );
    await memory.syncFactEmbeddings(changed);

    const results = await memory.searchRelevantFacts({
      queryTexts: ["最近很累"],
      facts: await memory.listFacts(),
      limit: 5
    });

    assert.equal(results[0]?.fact.key, "状态.直接");
    assert.equal(results[0]?.lexicalHit, true);
    assert.equal(memory.getEmbedderStatus().mode, "bm25-only");
  } finally {
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});

test("searchRelevantFacts: BM25 can match Chinese two-character tokens and symbol-heavy english tokens", async () => {
  const paths = await createTempPaths("yobi-bm25-tokens-");
  try {
    const config = cloneConfig();
    config.memory.embedding.enabled = false;
    const memory = new YobiMemory(paths, () => config);
    await memory.init();

    await memory.getFactsStore().applyOperations(
      [
        {
          action: "add",
          fact: {
            entity: "用户",
            key: "游戏",
            value: "最近在玩原神",
            category: "event",
            confidence: 0.8,
            ttl_class: "active"
          }
        },
        {
          action: "add",
          fact: {
            entity: "用户",
            key: "技术",
            value: "旧版本 3.0 工具链用了 BM25 和 C++ 扩展",
            category: "event",
            confidence: 0.8,
            ttl_class: "active"
          }
        }
      ],
      "test"
    );

    const chinese = await memory.searchRelevantFacts({ queryTexts: ["原神"], limit: 5 });
    const english = await memory.searchRelevantFacts({ queryTexts: ["C++"], limit: 5 });
    const version = await memory.searchRelevantFacts({ queryTexts: ["3.0"], limit: 5 });

    assert.equal(chinese[0]?.fact.key, "游戏");
    assert.equal(english[0]?.fact.key, "技术");
    assert.equal(version[0]?.fact.key, "技术");
  } finally {
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});

test("searchRelevantFacts: stop-word-only query returns empty results", async () => {
  const paths = await createTempPaths("yobi-empty-query-");
  try {
    const config = cloneConfig();
    config.memory.embedding.enabled = false;
    const memory = new YobiMemory(paths, () => config);
    await memory.init();

    await memory.getFactsStore().applyOperations(
      [
        {
          action: "add",
          fact: {
            entity: "用户",
            key: "偏好",
            value: "喜欢咖啡",
            category: "preference",
            confidence: 0.8,
            ttl_class: "stable"
          }
        }
      ],
      "test"
    );

    const results = await memory.searchRelevantFacts({ queryTexts: ["的 了 和"], limit: 5 });
    assert.deepEqual(results, []);
  } finally {
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});

test("legacy facts json files are ignored by SQLite facts store", async () => {
  const paths = await createTempPaths("yobi-legacy-ignore-");
  try {
    await fs.writeFile(
      paths.factsPath,
      JSON.stringify([
        {
          id: "legacy-1",
          entity: "用户",
          key: "旧数据",
          value: "不应被读取",
          category: "event",
          confidence: 0.9,
          source: "legacy",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ttl_class: "stable",
          last_accessed_at: new Date().toISOString(),
          superseded_by: null
        }
      ]),
      "utf8"
    );

    const config = cloneConfig();
    const memory = new YobiMemory(paths, () => config);
    await memory.init();

    assert.deepEqual(await memory.listFacts(), []);
  } finally {
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});

test("assembleContext: preserves ranked candidate order instead of re-scoring lexically", () => {
  const selected = assembleContext({
    soul: "soul",
    persona: "persona",
    stage: "stranger",
    state: DEFAULT_KERNEL_STATE,
    profile: DEFAULT_USER_PROFILE,
    buffer: [
      {
        id: "msg-000001",
        ts: new Date().toISOString(),
        role: "user",
        channel: "console",
        text: "我今天好累"
      }
    ],
    facts: [
      {
        id: "fact-semantic",
        entity: "用户",
        key: "状态.语义",
        value: "最近加班较多",
        category: "event",
        confidence: 0.9,
        source: "test",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ttl_class: "active",
        last_accessed_at: new Date().toISOString(),
        superseded_by: null
      },
      {
        id: "fact-lexical",
        entity: "用户",
        key: "状态.直接",
        value: "最近很累",
        category: "event",
        confidence: 0.7,
        source: "test",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ttl_class: "active",
        last_accessed_at: new Date().toISOString(),
        superseded_by: null
      }
    ],
    episodes: [],
    maxTokens: 6000,
    memoryFloorTokens: 1200
  });

  assert.deepEqual(
    selected.selectedFacts.map((fact) => fact.id),
    ["fact-semantic", "fact-lexical"]
  );
});

test("touchFacts: updates access time without mutating updated_at", async () => {
  const paths = await createTempPaths("yobi-touch-");
  try {
    const config = cloneConfig();
    const memory = new YobiMemory(paths, () => config);
    await memory.init();

    const [fact] = await memory.getFactsStore().applyOperations(
      [
        {
          action: "add",
          fact: {
            entity: "用户",
            key: "偏好",
            value: "咖啡",
            category: "preference",
            confidence: 0.9,
            ttl_class: "stable"
          }
        }
      ],
      "test"
    );

    const before = (await memory.listFacts())[0];
    assert.ok(before);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await memory.touchFacts([fact.id]);
    const after = (await memory.listFacts())[0];

    assert.equal(after?.updated_at, before?.updated_at);
    assert.notEqual(after?.last_accessed_at, before?.last_accessed_at);
  } finally {
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});

test("FactsStore.cleanupExpired: applies soft cap after expiry cleanup", async () => {
  const paths = await createTempPaths("yobi-soft-cap-");
  try {
    const config = cloneConfig();
    const memory = new YobiMemory(paths, () => config);
    await memory.init();

    await memory.getFactsStore().applyOperations(
      [
        {
          action: "add",
          fact: {
            entity: "用户",
            key: "事实.一",
            value: "A",
            category: "event",
            confidence: 0.8,
            ttl_class: "stable"
          }
        },
        {
          action: "add",
          fact: {
            entity: "用户",
            key: "事实.二",
            value: "B",
            category: "event",
            confidence: 0.8,
            ttl_class: "stable"
          }
        }
      ],
      "test"
    );

    const facts = await memory.listFacts();
    await memory.touchFacts([facts[1]!.id]);
    await memory.getFactsStore().cleanupExpired(new Date().toISOString(), 1);

    const active = await memory.listFacts();
    const archived = await memory.listFactArchive();
    assert.equal(active.length, 1);
    assert.equal(active[0]?.key, "事实.二");
    assert.equal(archived.length, 1);
    assert.equal(archived[0]?.key, "事实.一");
  } finally {
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});

test("scheduleDailyTasks: catches up yesterday after target hour and does not duplicate", async () => {
  const paths = await createTempPaths("yobi-daily-catchup-");
  try {
    const config = cloneConfig();
    config.kernel.dailyTaskHour = 3;
    const memory = new YobiMemory(paths, () => config);
    const stateStore = new StateStore(paths);
    await memory.init();
    await stateStore.init();

    const engine = new KernelEngine({
      paths,
      memory,
      stateStore,
      getConfig: () => config,
      resourceId: "main",
      threadId: "main",
      backgroundWorker: {
        init: async () => undefined,
        getStatus: () => ({ available: false, message: "stub" })
      } as any,
      queueHandlers: [],
      proactiveRewriteHandler: {
        rewrite: async () => null,
        getWorkerStatus: () => ({ available: false, message: "stub" }),
        getPauseReason: () => "stub"
      }
    });
    await engine.init();

    await withFixedNow(new Date(2026, 2, 10, 10, 0, 0), async () => {
      await (engine as any).scheduleDailyTasks(false);
      await (engine as any).scheduleDailyTasks(false);
    });

    const queued = (engine as any).taskQueue.list();
    assert.equal(queued.length, 3);
    assert.ok(queued.every((task: PendingTask) => task.payload.dayKey === "2026-03-09"));
  } finally {
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});
