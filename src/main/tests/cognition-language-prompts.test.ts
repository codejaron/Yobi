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
    user: "我最近总是加班，好累。",
    assistant: "你最近压力很大。",
    nowIso: "2026-03-26T00:00:00.000Z"
  });

  assert.match(prompt, /same language as the latest user message/i);
  assert.match(prompt, /facts\[\] strings, fact\.value, and graph\.nodes\[\]\.content/i);
  assert.match(prompt, /fact\.key should remain concise and stable across turns/i);
  assert.match(prompt, /Do not translate placeholders, proper names, product names, code, commands, file paths, version numbers, or quoted text/i);
  assert.match(prompt, /graph\.edges\[\]\.source_content\/target_content and graph\.entity_merges must reuse the exact node content or mention text/i);
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
    };
    const system = workerModule.buildDailyEpisodeSystemPrompt();

    assert.match(system, /same language as the input dialogue/i);
    assert.match(system, /Do not translate/i);
  } finally {
    runtimeProcess.parentPort = originalParentPort;
  }
});
