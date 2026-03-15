import test from "node:test";
import assert from "node:assert/strict";
import {
  applyConsoleEventToAssistantProcess,
  buildToolInputPreview,
  createAssistantTurnProcess
} from "@shared/tool-trace";
import type { AssistantTurnProcess } from "@shared/tool-trace";
import type { ConsoleRunEventV2 } from "@shared/types";

function applyByRequest(
  state: Record<string, AssistantTurnProcess>,
  event: ConsoleRunEventV2
): Record<string, AssistantTurnProcess> {
  return {
    ...state,
    [event.requestId]: applyConsoleEventToAssistantProcess(state[event.requestId], event)
  };
}

test("buildToolInputPreview: prefers key search/query/url/path/command in order", () => {
  assert.equal(
    buildToolInputPreview({ query: "GitHub trending", url: "https://example.com" }),
    "搜索：GitHub trending"
  );
  assert.equal(
    buildToolInputPreview({ config: { url: "https://example.com/page" } }),
    "URL：https://example.com/page"
  );
  assert.equal(
    buildToolInputPreview({ cmd: "npm test", path: "/tmp/demo" }),
    "路径：/tmp/demo"
  );
});

test("assistant process: hides thinking after first visible content and does not reshow", () => {
  let state = createAssistantTurnProcess();

  state = applyConsoleEventToAssistantProcess(state, {
    requestId: "r1",
    type: "thinking",
    state: "start",
    timestamp: "2026-03-12T10:00:00.000Z"
  });
  assert.equal(state.thinkingVisible, true);

  state = applyConsoleEventToAssistantProcess(state, {
    requestId: "r1",
    type: "tool-call",
    toolCallId: "tool-1",
    toolName: "search_web",
    input: { q: "Yobi tool trace" },
    timestamp: "2026-03-12T10:00:01.000Z"
  });
  assert.equal(state.thinkingVisible, false);
  assert.equal(state.tools.length, 1);
  assert.equal(state.tools[0]?.status, "running");

  state = applyConsoleEventToAssistantProcess(state, {
    requestId: "r1",
    type: "thinking",
    state: "start",
    timestamp: "2026-03-12T10:00:02.000Z"
  });
  assert.equal(state.thinkingVisible, false);

  state = applyConsoleEventToAssistantProcess(state, {
    requestId: "r1",
    type: "tool-result",
    toolCallId: "tool-1",
    toolName: "search_web",
    input: { q: "Yobi tool trace" },
    output: { items: [1, 2, 3] },
    success: true,
    timestamp: "2026-03-12T10:00:03.250Z"
  });
  assert.equal(state.tools[0]?.status, "success");
  assert.equal(state.tools[0]?.durationMs, 2250);
});

test("assistant process: failed terminal state marks unfinished tools aborted", () => {
  let state = createAssistantTurnProcess();

  state = applyConsoleEventToAssistantProcess(state, {
    requestId: "r1",
    type: "tool-call",
    toolCallId: "tool-1",
    toolName: "web_fetch",
    input: { url: "https://example.com" },
    timestamp: "2026-03-12T10:00:00.000Z"
  });

  state = applyConsoleEventToAssistantProcess(state, {
    requestId: "r1",
    type: "error",
    message: "LLM 回复已中断。",
    timestamp: "2026-03-12T10:00:05.000Z"
  });

  assert.equal(state.tools[0]?.status, "aborted");
  assert.equal(state.tools[0]?.durationMs, 5000);
});

test("assistant process: requestId isolation keeps tool cards on their own turns", () => {
  let state: Record<string, AssistantTurnProcess> = {};

  state = applyByRequest(state, {
    requestId: "r1",
    type: "tool-call",
    toolCallId: "tool-1",
    toolName: "search_web",
    input: { q: "first turn" },
    timestamp: "2026-03-12T10:00:00.000Z"
  });
  state = applyByRequest(state, {
    requestId: "r2",
    type: "text-delta",
    delta: "第二轮没有工具",
    timestamp: "2026-03-12T10:00:00.500Z"
  });
  state = applyByRequest(state, {
    requestId: "r1",
    type: "tool-result",
    toolCallId: "tool-1",
    toolName: "search_web",
    input: { q: "first turn" },
    output: { ok: true },
    success: true,
    timestamp: "2026-03-12T10:00:01.000Z"
  });

  assert.equal(state.r1?.tools.length, 1);
  assert.equal(state.r1?.tools[0]?.status, "success");
  assert.equal(state.r2?.tools.length, 0);
  assert.equal(state.r2?.hasVisibleContent, true);
});

test("assistant process: keeps text and tool blocks interleaved in event order", () => {
  let state = createAssistantTurnProcess();

  state = applyConsoleEventToAssistantProcess(state, {
    requestId: "r1",
    type: "text-delta",
    delta: "我先查一下。",
    timestamp: "2026-03-12T10:00:00.000Z"
  });
  state = applyConsoleEventToAssistantProcess(state, {
    requestId: "r1",
    type: "tool-call",
    toolCallId: "tool-1",
    toolName: "browser",
    input: { action: "snapshot" },
    timestamp: "2026-03-12T10:00:01.000Z"
  });
  state = applyConsoleEventToAssistantProcess(state, {
    requestId: "r1",
    type: "tool-result",
    toolCallId: "tool-1",
    toolName: "browser",
    input: { action: "snapshot" },
    output: { ok: true },
    success: true,
    timestamp: "2026-03-12T10:00:01.120Z"
  });
  state = applyConsoleEventToAssistantProcess(state, {
    requestId: "r1",
    type: "text-delta",
    delta: "现在我有结果了。",
    timestamp: "2026-03-12T10:00:02.000Z"
  });

  assert.deepEqual(
    state.blocks.map((block) =>
      block.type === "text"
        ? { type: "text", text: block.text }
        : { type: "tool", toolName: block.item.toolName, status: block.item.status }
    ),
    [
      { type: "text", text: "我先查一下。" },
      { type: "tool", toolName: "browser", status: "success" },
      { type: "text", text: "现在我有结果了。" }
    ]
  );
});

test("assistant process: hydrates persisted timeline blocks for history replay", () => {
  const state = createAssistantTurnProcess({
    timeline: [
      { type: "text", text: "先说明背景。" },
      {
        type: "tool",
        tool: {
          toolName: "browser",
          status: "success",
          inputPreview: "URL：https://example.com",
          durationMs: 188
        }
      },
      { type: "text", text: "再给出结论。" }
    ]
  });

  assert.deepEqual(
    state.blocks.map((block) =>
      block.type === "text"
        ? { type: "text", text: block.text }
        : { type: "tool", toolName: block.item.toolName, status: block.item.status }
    ),
    [
      { type: "text", text: "先说明背景。" },
      { type: "tool", toolName: "browser", status: "success" },
      { type: "text", text: "再给出结论。" }
    ]
  );
});
