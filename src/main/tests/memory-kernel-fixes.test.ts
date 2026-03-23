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
import { RuntimeDataCoordinator } from "../runtime/data-coordinator.js";
import { ensureKernelBootstrap } from "../kernel/init.js";
import { MemoryGraphStore } from "../cognition/graph/memory-graph.js";
import {
  createDefaultEmotionalState,
  DEFAULT_CONFIG,
  DEFAULT_KERNEL_STATE,
  DEFAULT_RELATIONSHIP_GUIDE,
  DEFAULT_USER_PROFILE,
  type AppConfig,
  type PendingTask
} from "@shared/types";
import { DEFAULT_COGNITION_CONFIG } from "@shared/cognition";

function cloneConfig(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

async function createTempPaths(prefix: string): Promise<CompanionPaths> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const paths = new CompanionPaths(baseDir);
  paths.ensureLayout();
  return paths;
}

async function cleanupMemoryPaths(paths: CompanionPaths, memory: YobiMemory | null): Promise<void> {
  await memory?.stop();
  await fs.rm(paths.baseDir, { recursive: true, force: true });
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
  let memory: YobiMemory | null = null;
  try {
    const config = cloneConfig();
    memory = new YobiMemory(paths, () => config);
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
    await cleanupMemoryPaths(paths, memory);
  }
});

test("YobiMemory.stop: closes facts store handles", async () => {
  const paths = await createTempPaths("yobi-memory-stop-");
  const config = cloneConfig();
  const memory = new YobiMemory(paths, () => config);

  try {
    await memory.init();

    assert.ok((memory.getFactsStore() as any).db);
    await memory.stop();
    assert.equal((memory.getFactsStore() as any).db, null);
  } finally {
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});

test("listHistory: preserves toolTrace metadata for assistant messages", async () => {
  const paths = await createTempPaths("yobi-history-tool-trace-");
  let memory: YobiMemory | null = null;
  try {
    const config = cloneConfig();
    memory = new YobiMemory(paths, () => config);
    await memory.init();

    await memory.rememberMessage({
      threadId: "main",
      resourceId: "main",
      role: "assistant",
      text: "已完成搜索。",
      metadata: {
        channel: "console",
        toolTrace: {
          items: [
            {
              toolName: "search_web",
              status: "success",
              inputPreview: "搜索：Yobi",
              durationMs: 820
            }
          ]
        },
        assistantTimeline: {
          blocks: [
            {
              type: "tool",
              tool: {
                toolName: "search_web",
                status: "success",
                inputPreview: "搜索：Yobi",
                durationMs: 820
              }
            },
            {
              type: "text",
              text: "已完成搜索。"
            }
          ]
        }
      }
    });

    const recent = await memory.listHistoryByCursor({
      threadId: "main",
      resourceId: "main",
      limit: 20
    });

    assert.deepEqual(recent.items[0]?.meta?.toolTrace, {
      items: [
        {
          toolName: "search_web",
          status: "success",
          inputPreview: "搜索：Yobi",
          durationMs: 820
        }
      ]
    });
    assert.deepEqual(recent.items[0]?.meta?.assistantTimeline, {
      blocks: [
        {
          type: "tool",
          tool: {
            toolName: "search_web",
            status: "success",
            inputPreview: "搜索：Yobi",
            durationMs: 820
          }
        },
        {
          type: "text",
          text: "已完成搜索。"
        }
      ]
    });
  } finally {
    await cleanupMemoryPaths(paths, memory);
  }
});

test("memory: allows empty assistant message when toolTrace is present and excludes it from prompt context", async () => {
  const paths = await createTempPaths("yobi-history-empty-tool-trace-");
  let memory: YobiMemory | null = null;
  try {
    const config = cloneConfig();
    memory = new YobiMemory(paths, () => config);
    await memory.init();

    await memory.rememberMessage({
      threadId: "main",
      resourceId: "main",
      role: "assistant",
      text: "",
      metadata: {
        channel: "console",
        toolTrace: {
          items: [
            {
              toolName: "search_web",
              status: "aborted",
              inputPreview: "搜索：北京天气"
            }
          ]
        }
      }
    });

    const recent = await memory.listHistoryByCursor({
      threadId: "main",
      resourceId: "main",
      limit: 20
    });
    const promptMessages = await memory.mapRecentToModelMessages({
      threadId: "main",
      resourceId: "main"
    });

    assert.equal(recent.items[0]?.text, "");
    assert.deepEqual(recent.items[0]?.meta?.toolTrace, {
      items: [
        {
          toolName: "search_web",
          status: "aborted",
          inputPreview: "搜索：北京天气"
        }
      ]
    });
    assert.equal(promptMessages.length, 0);
  } finally {
    await cleanupMemoryPaths(paths, memory);
  }
});

test("memory: only replays the latest attachment-bearing user message as media", async () => {
  const paths = await createTempPaths("yobi-history-attachments-active-");
  let memory: YobiMemory | null = null;
  try {
    const config = cloneConfig();
    memory = new YobiMemory(paths, () => config);
    await memory.init();

    const olderAttachmentPath = path.join(paths.chatMediaDir, "older.txt");
    const newerAttachmentPath = path.join(paths.chatMediaDir, "newer.txt");
    await fs.writeFile(olderAttachmentPath, "older attachment", "utf8");
    await fs.writeFile(newerAttachmentPath, "newer attachment", "utf8");

    await memory.rememberMessage({
      threadId: "main",
      resourceId: "main",
      role: "user",
      text: "第一张附件",
      metadata: {
        channel: "console",
        attachments: [
          {
            id: "attachment-older",
            kind: "file",
            filename: "older.txt",
            mimeType: "text/plain",
            size: 16,
            path: olderAttachmentPath,
            source: "user-upload",
            createdAt: new Date().toISOString()
          }
        ]
      }
    });
    await memory.rememberMessage({
      threadId: "main",
      resourceId: "main",
      role: "assistant",
      text: "收到了第一张",
      metadata: { channel: "console" }
    });
    await memory.rememberMessage({
      threadId: "main",
      resourceId: "main",
      role: "user",
      text: "第二张附件",
      metadata: {
        channel: "console",
        attachments: [
          {
            id: "attachment-newer",
            kind: "file",
            filename: "newer.txt",
            mimeType: "text/plain",
            size: 16,
            path: newerAttachmentPath,
            source: "user-upload",
            createdAt: new Date().toISOString()
          }
        ]
      }
    });

    const promptMessages = await memory.mapRecentToModelMessages({
      threadId: "main",
      resourceId: "main"
    });

    assert.equal(promptMessages.length, 3);
    assert.equal(promptMessages[0]?.role, "user");
    assert.equal(typeof promptMessages[0]?.content, "string");
    assert.match(String(promptMessages[0]?.content), /\[附件引用：已超出自动复用窗口\]/);
    assert.equal(promptMessages[2]?.role, "user");
    assert.ok(Array.isArray(promptMessages[2]?.content));
    assert.equal((promptMessages[2]?.content as Array<{ type: string }>)[1]?.type, "file");
  } finally {
    await cleanupMemoryPaths(paths, memory);
  }
});

test("memory: missing attachment cache falls back to reference text instead of failing", async () => {
  const paths = await createTempPaths("yobi-history-attachments-missing-");
  let memory: YobiMemory | null = null;
  try {
    const config = cloneConfig();
    memory = new YobiMemory(paths, () => config);
    await memory.init();

    const attachmentPath = path.join(paths.chatMediaDir, "missing.txt");
    await fs.writeFile(attachmentPath, "temporary attachment", "utf8");

    await memory.rememberMessage({
      threadId: "main",
      resourceId: "main",
      role: "user",
      text: "",
      metadata: {
        channel: "console",
        attachments: [
          {
            id: "attachment-missing",
            kind: "file",
            filename: "missing.txt",
            mimeType: "text/plain",
            size: 18,
            path: attachmentPath,
            source: "user-upload",
            createdAt: new Date().toISOString()
          }
        ]
      }
    });
    await fs.rm(attachmentPath, { force: true });

    const promptMessages = await memory.mapRecentToModelMessages({
      threadId: "main",
      resourceId: "main"
    });

    assert.equal(promptMessages.length, 1);
    assert.equal(promptMessages[0]?.role, "user");
    assert.equal(typeof promptMessages[0]?.content, "string");
    assert.match(String(promptMessages[0]?.content), /\[附件引用：缓存缺失\]/);
    assert.match(String(promptMessages[0]?.content), /missing\.txt/);
  } finally {
    await cleanupMemoryPaths(paths, memory);
  }
});

test("memory: attachment auto-reuse expires after four later user messages", async () => {
  const paths = await createTempPaths("yobi-history-attachments-expire-");
  let memory: YobiMemory | null = null;
  try {
    const config = cloneConfig();
    memory = new YobiMemory(paths, () => config);
    await memory.init();

    const attachmentPath = path.join(paths.chatMediaDir, "expire.txt");
    await fs.writeFile(attachmentPath, "expire attachment", "utf8");

    await memory.rememberMessage({
      threadId: "main",
      resourceId: "main",
      role: "user",
      text: "初始附件",
      metadata: {
        channel: "console",
        attachments: [
          {
            id: "attachment-expire",
            kind: "file",
            filename: "expire.txt",
            mimeType: "text/plain",
            size: 17,
            path: attachmentPath,
            source: "user-upload",
            createdAt: new Date().toISOString()
          }
        ]
      }
    });

    for (let index = 1; index <= 5; index += 1) {
      await memory.rememberMessage({
        threadId: "main",
        resourceId: "main",
        role: "assistant",
        text: `回复-${index}`,
        metadata: { channel: "console" }
      });
      await memory.rememberMessage({
        threadId: "main",
        resourceId: "main",
        role: "user",
        text: `后续用户-${index}`,
        metadata: { channel: "console" }
      });
    }

    const promptMessages = await memory.mapRecentToModelMessages({
      threadId: "main",
      resourceId: "main"
    });

    assert.equal(promptMessages[0]?.role, "user");
    assert.equal(typeof promptMessages[0]?.content, "string");
    assert.match(String(promptMessages[0]?.content), /\[附件引用：已超出自动复用窗口\]/);
  } finally {
    await cleanupMemoryPaths(paths, memory);
  }
});

test("buffer compaction: removed messages persist into unprocessed queue", async () => {
  const paths = await createTempPaths("yobi-compaction-");
  let memory: YobiMemory | null = null;
  try {
    const config = cloneConfig();
    config.kernel.buffer.maxMessages = 20;
    config.kernel.buffer.lowWatermark = 10;
    memory = new YobiMemory(paths, () => config);
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
    await cleanupMemoryPaths(paths, memory);
  }
});

test("queuePendingBufferExtractions: marks buffered rows once and avoids duplicate claims", async () => {
  const paths = await createTempPaths("yobi-claim-");
  let memory: YobiMemory | null = null;
  try {
    const config = cloneConfig();
    memory = new YobiMemory(paths, () => config);
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
    await cleanupMemoryPaths(paths, memory);
  }
});

test("DailyEpisodeTaskHandler: uses payload dayKey and stores emotional context", async () => {
  const paths = await createTempPaths("yobi-episode-");
  let memory: YobiMemory | null = null;
  try {
    const config = cloneConfig();
    memory = new YobiMemory(paths, () => config);
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
    await cleanupMemoryPaths(paths, memory);
  }
});

test("searchRelevantFacts: bm25-only fallback keeps lexical hit when vector is unavailable", async () => {
  const paths = await createTempPaths("yobi-bm25-rank-");
  let memory: YobiMemory | null = null;
  try {
    const config = cloneConfig();
    config.memory.embedding.enabled = true;
    config.memory.embedding.modelId = "missing-model.gguf";
    memory = new YobiMemory(paths, () => config);
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
    await cleanupMemoryPaths(paths, memory);
  }
});

test("searchRelevantFacts: BM25 can match Chinese two-character tokens and symbol-heavy english tokens", async () => {
  const paths = await createTempPaths("yobi-bm25-tokens-");
  let memory: YobiMemory | null = null;
  try {
    const config = cloneConfig();
    config.memory.embedding.enabled = false;
    memory = new YobiMemory(paths, () => config);
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
    await cleanupMemoryPaths(paths, memory);
  }
});

test("searchRelevantFacts: stop-word-only query returns empty results", async () => {
  const paths = await createTempPaths("yobi-empty-query-");
  let memory: YobiMemory | null = null;
  try {
    const config = cloneConfig();
    config.memory.embedding.enabled = false;
    memory = new YobiMemory(paths, () => config);
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
    await cleanupMemoryPaths(paths, memory);
  }
});

test("legacy facts json files are ignored by SQLite facts store", async () => {
  const paths = await createTempPaths("yobi-legacy-ignore-");
  let memory: YobiMemory | null = null;
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
    memory = new YobiMemory(paths, () => config);
    await memory.init();

    assert.deepEqual(await memory.listFacts(), []);
  } finally {
    await cleanupMemoryPaths(paths, memory);
  }
});

test("assembleContext: preserves ranked candidate order instead of re-scoring lexically", () => {
  const selected = assembleContext({
    soul: "soul",
    relationship: DEFAULT_RELATIONSHIP_GUIDE,
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

test("assembleContext: emits a single SOUL block without PERSONA", () => {
  const selected = assembleContext({
    soul: "只保留 soul",
    relationship: {
      stages: {
        stranger: ["礼貌但有距离感。"],
        acquaintance: ["开始偶尔吐槽。"],
        familiar: [],
        close: [],
        intimate: []
      }
    },
    stage: "stranger",
    state: DEFAULT_KERNEL_STATE,
    profile: DEFAULT_USER_PROFILE,
    buffer: [],
    facts: [],
    episodes: [],
    maxTokens: 6000,
    memoryFloorTokens: 1200
  });

  assert.match(selected.system, /\[SOUL\]/);
  assert.match(selected.system, /\[RELATIONSHIP\]/);
  assert.doesNotMatch(selected.system, /\[PERSONA\]/);
  assert.match(selected.system, /只保留 soul/);
  assert.match(selected.system, /current_stage=stranger/);
  assert.match(selected.system, /allowed_values=\["stranger","acquaintance","familiar","close","intimate"\]/);
  assert.match(selected.system, /current_stage_rules=\["礼貌但有距离感。"\]/);
  assert.doesNotMatch(selected.system, /开始偶尔吐槽/);
  assert.doesNotMatch(selected.system, /shared_rules=/);
  assert.doesNotMatch(selected.system, /当前关系阶段:/);
});

test("assembleContext: emits structured STATE values with ranges", () => {
  const state = {
    ...DEFAULT_KERNEL_STATE,
    relationship: {
      ...DEFAULT_KERNEL_STATE.relationship,
      stage: "familiar" as const
    },
    emotional: {
      ...createDefaultEmotionalState("familiar"),
      dimensions: {
        pleasure: 0.2,
        arousal: 0.18,
        dominance: -0.2,
        curiosity: 0.47,
        energy: 0.83,
        trust: 0.58
      },
      ekman: {
        happiness: 0,
        sadness: 0,
        anger: 0.15,
        fear: 0,
        disgust: 0,
        surprise: 0.12
      },
      connection: 0.61,
      sessionWarmth: 0.72
    },
    ruminationQueue: [
      {
        label: "frustrated",
        intensity: 0.8,
        remainingStages: 3,
        triggeredAt: new Date(0).toISOString()
      }
    ],
    sessionReentry: {
      active: true,
      gapHours: 27,
      gapLabel: "1 天",
      activatedAt: new Date(0).toISOString()
    }
  };

  const selected = assembleContext({
    soul: "只保留 soul",
    relationship: {
      ...DEFAULT_RELATIONSHIP_GUIDE,
      stages: {
        ...DEFAULT_RELATIONSHIP_GUIDE.stages,
        familiar: ["交流更自然。"]
      }
    },
    stage: "familiar",
    state,
    profile: DEFAULT_USER_PROFILE,
    buffer: [],
    facts: [],
    episodes: [],
    maxTokens: 6000,
    memoryFloorTokens: 1200
  });

  assert.match(selected.system, /\[STATE\]/);
  assert.match(selected.system, /relationship_stage=familiar/);
  assert.match(selected.system, /pleasure=0.20 baseline=0.00 range=\[-1.00,1.00\]/);
  assert.match(selected.system, /arousal=0.18 baseline=0.00 range=\[-1.00,1.00\]/);
  assert.match(selected.system, /dominance=-0.20 baseline=0.00 range=\[-1.00,1.00\]/);
  assert.match(selected.system, /trust=0.58 range=\[0.00,1.00\] higher=more_trusting/);
  assert.match(selected.system, /connection=0.61 range=\[0.00,1.00\] higher=more_connected/);
  assert.match(selected.system, /sessionWarmth=0.72 range=\[0.00,1.00\] higher=warmer_session/);
  assert.match(selected.system, /anger=0.15 range=\[0.00,1.00\]/);
  assert.match(selected.system, /surprise=0.12 range=\[0.00,1.00\]/);
  assert.match(selected.system, /active_ruminations=1 range=\[0,\+inf\)/);
  assert.match(selected.system, /rumination_labels=\["frustrated"\]/);
  assert.doesNotMatch(selected.system, /mood=/);
  assert.doesNotMatch(selected.system, /confidence=/);
  assert.doesNotMatch(selected.system, /irritation=/);
});

test("assembleContext: emits PROFILE block between STATE and MEMORY using selected fields", () => {
  const selected = assembleContext({
    soul: "只保留 soul",
    relationship: DEFAULT_RELATIONSHIP_GUIDE,
    stage: "stranger",
    state: DEFAULT_KERNEL_STATE,
    profile: {
      ...DEFAULT_USER_PROFILE,
      communication: {
        ...DEFAULT_USER_PROFILE.communication,
        avg_message_length: "long",
        emoji_usage: "occasional",
        humor_receptivity: 0.7,
        advice_receptivity: 0.4,
        emotional_openness: 0.6,
        preferred_comfort_style: "倾听型",
        catchphrases: ["先别急", "行吧"]
      },
      patterns: {
        ...DEFAULT_USER_PROFILE.patterns,
        active_hours: "22:00-01:00",
        topic_preferences: ["技术", "音乐"]
      },
      interaction_notes: {
        ...DEFAULT_USER_PROFILE.interaction_notes,
        sensitive_topics: ["裁员", "家人健康"],
        what_works: ["直接给结论", "少寒暄"],
        what_fails: ["追问太多"]
      },
      pending_confirmations: [
        {
          id: "pending-1",
          field: "identity.timezone",
          value: "Asia/Shanghai",
          needs_confirmation: true,
          confirmed: false,
          created_at: new Date().toISOString()
        }
      ]
    },
    buffer: [],
    facts: [],
    episodes: [],
    maxTokens: 6000,
    memoryFloorTokens: 1200
  });

  assert.match(selected.system, /\[STATE\][\s\S]*\[PROFILE\][\s\S]*\[MEMORY\]/);
  assert.match(selected.system, /消息风格=long/);
  assert.match(selected.system, /emoji=occasional/);
  assert.match(selected.system, /幽默接受度=0.70/);
  assert.match(selected.system, /建议接受度=0.40/);
  assert.match(selected.system, /情感开放度=0.60/);
  assert.match(selected.system, /安慰偏好=倾听型/);
  assert.match(selected.system, /活跃时段=22:00-01:00/);
  assert.match(selected.system, /敏感话题=\["裁员","家人健康"\]/);
  assert.match(selected.system, /有效策略=\["直接给结论","少寒暄"\]/);
  assert.match(selected.system, /无效策略=\["追问太多"\]/);
  assert.match(selected.system, /口头禅=\["先别急","行吧"\]/);
  assert.doesNotMatch(selected.system, /topic_preferences/);
  assert.doesNotMatch(selected.system, /pending_confirmations/);
  assert.doesNotMatch(selected.system, /trust_areas/);
});

test("assembleContext: reserves separate budgets for recent messages facts and episodes", () => {
  const longText = "这是一段很长的内容，用来稳定吃掉预算并验证分段预算不会互相饿死。".repeat(12);
  const selected = assembleContext({
    soul: "只保留 soul",
    relationship: DEFAULT_RELATIONSHIP_GUIDE,
    stage: "stranger",
    state: DEFAULT_KERNEL_STATE,
    profile: DEFAULT_USER_PROFILE,
    buffer: Array.from({ length: 12 }, (_, index) => ({
      id: `msg-${String(index + 1).padStart(6, "0")}`,
      ts: new Date().toISOString(),
      role: index % 2 === 0 ? "user" : "assistant",
      channel: "console" as const,
      text: `第 ${index + 1} 条消息 ${longText}`
    })),
    facts: Array.from({ length: 8 }, (_, index) => ({
      id: `fact-${index + 1}`,
      entity: "用户",
      key: `事实.${index + 1}`,
      value: `${longText}${index + 1}`,
      category: "event" as const,
      confidence: 0.8,
      source: "test",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ttl_class: "active" as const,
      last_accessed_at: new Date().toISOString(),
      superseded_by: null
    })),
    episodes: Array.from({ length: 6 }, (_, index) => ({
      id: `episode-${index + 1}`,
      date: `2026-03-${String(index + 1).padStart(2, "0")}`,
      summary: `第 ${index + 1} 天总结 ${longText}`,
      emotional_context: {
        user_mood: "unknown",
        yobi_mood: "neutral"
      },
      unresolved: [`待解决问题 ${index + 1} ${longText}`],
      significance: 0.8,
      source_ranges: [`day:2026-03-${String(index + 1).padStart(2, "0")}`],
      updated_at: new Date().toISOString()
    })),
    maxTokens: 3200,
    memoryFloorTokens: 1200,
    externalFixedTokens: 200
  });

  assert.ok(selected.maxRecentMessages > 0);
  assert.ok(selected.selectedFacts.length > 0);
  assert.ok(selected.selectedEpisodes.length > 0);
});

test("assembleContext: external fixed tokens reduce available recent message budget", () => {
  const longMessage = "最近消息预算需要独立测一下。".repeat(20);
  const baseInput = {
    soul: "只保留 soul",
    relationship: DEFAULT_RELATIONSHIP_GUIDE,
    stage: "stranger" as const,
    state: DEFAULT_KERNEL_STATE,
    profile: DEFAULT_USER_PROFILE,
    buffer: Array.from({ length: 16 }, (_, index) => ({
      id: `msg-${String(index + 1).padStart(6, "0")}`,
      ts: new Date().toISOString(),
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      channel: "console" as const,
      text: `${index + 1}:${longMessage}`
    })),
    facts: [],
    episodes: [],
    maxTokens: 5000,
    memoryFloorTokens: 1200
  };

  const withoutExternalFixed = assembleContext({
    ...baseInput,
    externalFixedTokens: 0
  });
  const withExternalFixed = assembleContext({
    ...baseInput,
    externalFixedTokens: 1200
  });

  assert.ok(withExternalFixed.maxRecentMessages < withoutExternalFixed.maxRecentMessages);
});

test("ensureKernelBootstrap: creates soul.md, relationship.json, and a bundled default cognition graph without persona.md", async () => {
  const paths = await createTempPaths("yobi-soul-bootstrap-");
  try {
    await ensureKernelBootstrap(paths);

    await fs.access(paths.soulPath);
    await fs.access(paths.relationshipPath);
    await fs.access(paths.cognitionGraphHotPath);
    await assert.rejects(() => fs.access(path.join(paths.baseDir, "persona.md")));

    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    const stats = graph.getStatistics();
    assert.equal(stats.nodeCount, 34);
    assert.equal(stats.edgeCount, 21);
    assert.ok(graph.getAllNodes().some((node) => node.content === "养了一只橘猫叫Bean，因为JavaBean"));
    assert.ok(
      graph.getAllEdges().some((edge) =>
        graph.getNode(edge.source)?.content === "碰到分布式的活会兴奋" &&
        graph.getNode(edge.target)?.content === "兴奋" &&
        edge.relation_type === "emotional"
      )
    );
  } finally {
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});

test("RuntimeDataCoordinator.getMindSnapshot: returns soul and relationship snapshot", async () => {
  const paths = await createTempPaths("yobi-soul-snapshot-");
  let memory: YobiMemory | null = null;
  try {
    const config = cloneConfig();
    memory = new YobiMemory(paths, () => config);
    await memory.init();

    const stateStore = new StateStore(paths);
    await stateStore.init();

    await fs.writeFile(paths.soulPath, "# Soul only\n", "utf8");
    await fs.writeFile(
      paths.relationshipPath,
      `${JSON.stringify(
        {
          stages: {
            stranger: ["客气但有距离感"],
            acquaintance: [],
            familiar: [],
            close: [],
            intimate: []
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await fs.writeFile(path.join(paths.baseDir, "persona.md"), "# Ignored persona\n", "utf8");

    const coordinator = new RuntimeDataCoordinator({
      paths,
      memory,
      stateStore,
      kernel: {
        runDailyNow: async () => undefined,
        runTickNow: async () => undefined
      } as unknown as KernelEngine,
      bilibiliBrowse: {} as any,
      bilibiliSyncCoordinator: {} as any,
      systemPermissionsService: {} as any,
      resourceId: "main",
      threadId: "main",
      emitStatus: async () => undefined
    });

    const snapshot = await coordinator.getMindSnapshot();

    assert.equal(snapshot.soul, "# Soul only\n");
    assert.deepEqual(snapshot.relationship, {
      stages: {
        stranger: ["客气但有距离感"],
        acquaintance: [],
        familiar: [],
        close: [],
        intimate: []
      }
    });
    assert.equal("persona" in snapshot, false);
  } finally {
    await cleanupMemoryPaths(paths, memory);
  }
});

test("RuntimeDataCoordinator.regenerateCognitionGraphFromSoul delegates to the explicit rebuild callback", async () => {
  const paths = await createTempPaths("yobi-soul-regenerate-");
  let memory: YobiMemory | null = null;
  try {
    const config = cloneConfig();
    memory = new YobiMemory(paths, () => config);
    await memory.init();

    const stateStore = new StateStore(paths);
    await stateStore.init();

    let calls = 0;
    const coordinator = new RuntimeDataCoordinator({
      paths,
      memory,
      stateStore,
      kernel: {
        runDailyNow: async () => undefined,
        runTickNow: async () => undefined
      } as unknown as KernelEngine,
      bilibiliBrowse: {} as any,
      bilibiliSyncCoordinator: {} as any,
      systemPermissionsService: {} as any,
      resourceId: "resource",
      threadId: "thread",
      emitStatus: async () => undefined,
      regenerateCognitionGraphFromSoul: async () => {
        calls += 1;
        return {
          accepted: true,
          message: "认知图已按当前 SOUL 重建。"
        };
      }
    });

    const result = await coordinator.regenerateCognitionGraphFromSoul();
    assert.equal(calls, 1);
    assert.deepEqual(result, {
      accepted: true,
      message: "认知图已按当前 SOUL 重建。"
    });
  } finally {
    await cleanupMemoryPaths(paths, memory);
  }
});

test("touchFacts: updates access time without mutating updated_at", async () => {
  const paths = await createTempPaths("yobi-touch-");
  let memory: YobiMemory | null = null;
  try {
    const config = cloneConfig();
    memory = new YobiMemory(paths, () => config);
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
    await cleanupMemoryPaths(paths, memory);
  }
});

test("FactsStore.cleanupExpired: applies soft cap after expiry cleanup", async () => {
  const paths = await createTempPaths("yobi-soft-cap-");
  let memory: YobiMemory | null = null;
  try {
    const config = cloneConfig();
    memory = new YobiMemory(paths, () => config);
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
    const factTwo = facts.find((fact) => fact.key === "事实.二");
    assert.ok(factTwo);
    await memory.touchFacts([factTwo.id]);
    await memory.getFactsStore().cleanupExpired(new Date().toISOString(), 1);

    const active = await memory.listFacts();
    const archived = await memory.listFactArchive();
    assert.equal(active.length, 1);
    assert.equal(active[0]?.key, "事实.二");
    assert.equal(archived.length, 1);
    assert.equal(archived[0]?.key, "事实.一");
  } finally {
    await cleanupMemoryPaths(paths, memory);
  }
});

test("scheduleDailyTasks: catches up yesterday after target hour and does not duplicate", async () => {
  const paths = await createTempPaths("yobi-daily-catchup-");
  let memory: YobiMemory | null = null;
  try {
    const config = cloneConfig();
    config.kernel.dailyTaskHour = 3;
    memory = new YobiMemory(paths, () => config);
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
    await cleanupMemoryPaths(paths, memory);
  }
});

test("KernelEngine.onUserMessage: does not enqueue legacy fact-extraction tasks from buffered messages", async () => {
  const paths = await createTempPaths("yobi-kernel-no-legacy-facts-");
  let memory: YobiMemory | null = null;
  try {
    const config = cloneConfig();
    memory = new YobiMemory(paths, () => config);
    const stateStore = new StateStore(paths);
    await memory.init();
    await stateStore.init();

    await memory.rememberMessage({
      threadId: "main",
      resourceId: "main",
      role: "user",
      text: "最近工作有点累",
      metadata: {
        channel: "console"
      }
    });
    await memory.rememberMessage({
      threadId: "main",
      resourceId: "main",
      role: "assistant",
      text: "那今晚早点休息",
      metadata: {
        channel: "console"
      }
    });

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

    await engine.onUserMessage({
      ts: "2026-03-13T12:00:00.000Z",
      text: "还在忙"
    });

    const queued = (engine as any).taskQueue.list() as PendingTask[];
    assert.equal(queued.some((task) => task.type === "fact-extraction"), false);
  } finally {
    await cleanupMemoryPaths(paths, memory);
  }
});

test("KernelEngine.onUserMessage: updates session reentry and resets sessionWarmth to stage baseline when no prior engagement exists", async () => {
  const paths = await createTempPaths("yobi-user-message-state-");
  let memory: YobiMemory | null = null;
  try {
    const config = cloneConfig();
    config.kernel.sessionReentryGapHours = 6;
    memory = new YobiMemory(paths, () => config);
    const stateStore = new StateStore(paths);
    await memory.init();
    await stateStore.init();

    stateStore.mutate((state) => {
      state.emotional = {
        ...createDefaultEmotionalState("stranger"),
        dimensions: {
          pleasure: 0.1,
          arousal: 0,
          dominance: 0,
          curiosity: 0.45,
          energy: 0.72,
          trust: 0.52
        },
        ekman: {
          happiness: 0,
          sadness: 0,
          anger: 0.08,
          fear: 0,
          disgust: 0,
          surprise: 0
        },
        connection: 0.64,
        sessionWarmth: 0.6
      };
    });

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

    engine.setLastUserMessageAt("2026-03-10T00:00:00.000Z");
    await engine.onUserMessage({
      ts: "2026-03-13T12:00:00.000Z",
      text: "嗯"
    });

    const snapshot = stateStore.getSnapshot();
    assert.deepEqual(snapshot.emotional, {
      dimensions: {
        pleasure: 0.1,
        arousal: 0,
        dominance: 0,
        curiosity: 0.45,
        energy: 0.72,
        trust: 0.52
      },
      ekman: {
        happiness: 0,
        sadness: 0,
        anger: 0.08,
        fear: 0,
        disgust: 0,
        surprise: 0
      },
      connection: 0.64,
      sessionWarmth: 0.2
    });
    assert.equal(snapshot.sessionReentry?.active, true);
    assert.equal(snapshot.sessionReentry?.gapHours, 84);
  } finally {
    await cleanupMemoryPaths(paths, memory);
  }
});

test("KernelEngine.onUserMessage: raises sessionWarmth using the latest engagement", async () => {
  const paths = await createTempPaths("yobi-session-warmth-engagement-");
  let memory: YobiMemory | null = null;
  try {
    const config = cloneConfig();
    memory = new YobiMemory(paths, () => config);
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

    engine.onRealtimeEmotionalSignals({
      emotion_label: "neutral",
      intensity: 0.5,
      engagement: 0.8,
      trust_delta: 0
    });
    await engine.onUserMessage({
      ts: "2026-03-13T12:00:00.000Z",
      text: "嗯"
    });

    const snapshot = stateStore.getSnapshot();
    assert.ok(Math.abs(snapshot.emotional.sessionWarmth - 0.24) < 1e-9);
  } finally {
    await cleanupMemoryPaths(paths, memory);
  }
});

test("KernelEngine.maybeEmitProactiveMessage: does not send cold-start greeting when user history is empty", async () => {
  const paths = await createTempPaths("yobi-no-cold-start-greeting-");
  let memory: YobiMemory | null = null;
  try {
    const config = cloneConfig();
    config.proactive.enabled = true;
    config.proactive.coldStartDelayMs = 0;
    config.proactive.cooldownMs = 0;
    config.proactive.silenceThresholdMs = 1;
    config.proactive.quietHours.enabled = false;
    memory = new YobiMemory(paths, () => config);
    const stateStore = new StateStore(paths);
    await memory.init();
    await stateStore.init();

    const emitted: string[] = [];
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
        rewrite: async ({ message }: { message: string }) => message,
        getWorkerStatus: () => ({ available: true, message: "stub" }),
        getPauseReason: () => null
      },
      onProactiveMessage: async ({ message }) => {
        emitted.push(message);
      }
    });
    await engine.init();

    await (engine as any).maybeEmitProactiveMessage();

    assert.deepEqual(emitted, []);
  } finally {
    await cleanupMemoryPaths(paths, memory);
  }
});

test("KernelEngine.tick: reschedules the next heartbeat when a tick step fails", async () => {
  const paths = await createTempPaths("yobi-tick-reschedule-");
  let memory: YobiMemory | null = null;
  try {
    const config = cloneConfig();
    memory = new YobiMemory(paths, () => config);
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

    const scheduled: number[] = [];
    (engine as any).running = true;
    (engine as any).processQueuedEvents = async () => {
      throw new Error("tick-step-failed");
    };
    (engine as any).resolveTickIntervalMs = () => 4321;
    (engine as any).scheduleNextTick = (delayMs: number) => {
      scheduled.push(delayMs);
    };

    await (engine as any).tick();

    assert.deepEqual(scheduled, [4321]);
    assert.equal(engine.getStatus().lastTickAt, null);
  } finally {
    await cleanupMemoryPaths(paths, memory);
  }
});

test("KernelEngine.runTickNow: still surfaces tick failures to the caller", async () => {
  const paths = await createTempPaths("yobi-run-tick-now-error-");
  let memory: YobiMemory | null = null;
  try {
    const config = cloneConfig();
    memory = new YobiMemory(paths, () => config);
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

    (engine as any).running = true;
    (engine as any).processQueuedEvents = async () => {
      throw new Error("manual-tick-failed");
    };

    await assert.rejects(engine.runTickNow(), /manual-tick-failed/);
  } finally {
    await cleanupMemoryPaths(paths, memory);
  }
});
