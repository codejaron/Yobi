import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import {
  buildClusterSummaryPrompt,
  buildColdStartSeedPrompt,
  buildDialogueExtractionPrompt
} from "../cognition/engine.js";

const require = createRequire(import.meta.url);

test("buildDialogueExtractionPrompt requires natural-language fields to follow the latest user message language", () => {
  const prompt = buildDialogueExtractionPrompt({
    channel: "console",
    chatId: "chat-1",
    transcript: [
      {
        role: "user",
        text: "我最近总是加班，好累。"
      },
      {
        role: "assistant",
        text: "你最近压力很大。"
      }
    ],
    latestUserMessage: "我最近总是加班，好累。",
    nowIso: "2026-03-26T00:00:00.000Z"
  });

  assert.match(prompt, /same language as the latest user message/i);
  assert.match(prompt, /facts\[\] strings, fact\.value, and graph\.nodes\[\]\.content/i);
  assert.match(prompt, /fact\.key should remain concise and stable across turns/i);
  assert.match(prompt, /Do not translate placeholders, proper names, product names, code, commands, file paths, version numbers, or quoted text/i);
  assert.match(prompt, /graph\.edges\[\]\.source_content\/target_content and graph\.entity_merges must reuse the exact node content or mention text/i);
});

test("buildDialogueExtractionPrompt accepts multi-round transcript input", () => {
  const prompt = buildDialogueExtractionPrompt({
    channel: "console",
    chatId: "chat-1",
    transcript: [
      {
        role: "user",
        text: "第一轮：我最近在学 Spring。"
      },
      {
        role: "assistant",
        text: "听起来你在补后端技能树。"
      },
      {
        role: "user",
        text: "第二轮：最近还在看 Redis。"
      },
      {
        role: "assistant",
        text: "这两块放在一起很适合后端日常。"
      }
    ],
    latestUserMessage: "第二轮：最近还在看 Redis。",
    nowIso: "2026-03-26T00:00:00.000Z"
  });

  assert.match(prompt, /第一轮：我最近在学 Spring。/);
  assert.match(prompt, /第二轮：最近还在看 Redis。/);
  assert.match(prompt, /same language as the latest user message/i);
});

test("buildColdStartSeedPrompt keeps cold-start node content in the soul language", () => {
  const prompt = buildColdStartSeedPrompt({
    soulMarkdown: "# Soul\n- 优先中文\n",
    targetNodeCount: 12
  });

  assert.match(prompt, /content field of each node must use the same language as the soul text/i);
  assert.match(prompt, /Do not translate/i);
});

test("buildClusterSummaryPrompt tells the model to preserve the input event language", () => {
  const prompt = buildClusterSummaryPrompt([
    { content: "最近几次都在聊晚餐安排" },
    { content: "还提到了周末做饭" }
  ]);

  assert.match(prompt, /请沿用这些事件本身的语言/i);
  assert.match(prompt, /不要翻译/i);
});

test("background worker daily episode system prompt preserves the dialogue language", async () => {
  const runtimeProcess = process as any;
  const originalParentPort = runtimeProcess.parentPort;
  runtimeProcess.parentPort = {
    on() {
      return runtimeProcess.parentPort;
    },
    postMessage() {}
  };

  try {
    const workerModule = require(path.resolve(process.cwd(), "src/main/workers/background-task-worker.cjs")) as {
      buildDailyEpisodeSystemPrompt: () => string;
      buildDailyEpisodePrompt: (input: {
        date: string;
        fallbackSummary: string;
        userMessageCount: number;
        dayItems: Array<{ role: string; text: string }>;
      }) => string;
      buildDailyReflectionSystemPrompt: () => string;
      buildDailyReflectionPrompt: (input: {
        episodes: Array<{ date: string; summary: string; significance: number }>;
      }) => string;
    };
    const system = workerModule.buildDailyEpisodeSystemPrompt();
    const dailyEpisodePrompt = workerModule.buildDailyEpisodePrompt({
      date: "2026-03-26",
      fallbackSummary: "当日共对话 3 条，用户消息 2 条。",
      userMessageCount: 2,
      dayItems: [
        { role: "user", text: "今天有点累" },
        { role: "assistant", text: "先休息一下" }
      ]
    });
    const reflectionSystem = workerModule.buildDailyReflectionSystemPrompt();
    const reflectionPrompt = workerModule.buildDailyReflectionPrompt({
      episodes: [
        { date: "2026-03-24", summary: "第一天", significance: 0.4 },
        { date: "2026-03-25", summary: "第二天", significance: 0.7 }
      ]
    });

    assert.match(system, /same language as the input dialogue/i);
    assert.match(system, /Do not translate/i);
    assert.match(system, /short mood labels/i);
    assert.match(system, /Do not mention, infer, or invent calendar dates/i);
    assert.equal(dailyEpisodePrompt.includes('"date"'), false);
    assert.equal(dailyEpisodePrompt.includes("2026-03-26"), false);

    assert.match(reflectionSystem, /All four scores are required/i);
    assert.match(reflectionSystem, /specificity/i);
    assert.match(reflectionSystem, /evidence/i);
    assert.match(reflectionSystem, /novelty/i);
    assert.match(reflectionSystem, /usefulness/i);
    assert.match(reflectionSystem, /Do not mention, infer, or invent calendar dates/i);
    assert.equal(reflectionPrompt.includes('"date"'), false);
    assert.equal(reflectionPrompt.includes("2026-03-24"), false);
    assert.equal(reflectionPrompt.includes("2026-03-25"), false);
  } finally {
    runtimeProcess.parentPort = originalParentPort;
  }
});
