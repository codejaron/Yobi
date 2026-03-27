import test from "node:test";
import assert from "node:assert/strict";
import {
  applyConsoleChatHistoryLoadError,
  createConsoleChatHistoryState,
  prependConsoleChatHistoryPage,
  replaceConsoleChatHistoryPage,
  resetConsoleChatHistoryState
} from "@shared/console-chat-history";

interface FakeMessage {
  id: string;
  text: string;
}

test("console chat history: replacing the initial page stores items and cursor state", () => {
  const state = replaceConsoleChatHistoryPage<FakeMessage>({
    items: [
      { id: "m-1", text: "第一条" },
      { id: "m-2", text: "第二条" }
    ],
    hasMore: true,
    nextCursor: "cursor-1"
  });

  assert.deepEqual(state, {
    items: [
      { id: "m-1", text: "第一条" },
      { id: "m-2", text: "第二条" }
    ],
    hasMore: true,
    nextCursor: "cursor-1",
    loadError: null
  });
});

test("console chat history: prepending an older page keeps order and removes duplicates", () => {
  const current = createConsoleChatHistoryState<FakeMessage>({
    items: [
      { id: "m-3", text: "第三条" },
      { id: "m-4", text: "第四条" }
    ],
    hasMore: true,
    nextCursor: "cursor-2",
    loadError: "历史加载失败，继续上滑重试"
  });

  const next = prependConsoleChatHistoryPage(current, {
    items: [
      { id: "m-1", text: "第一条" },
      { id: "m-2", text: "第二条" },
      { id: "m-3", text: "第三条" }
    ],
    hasMore: false,
    nextCursor: null
  });

  assert.deepEqual(next, {
    items: [
      { id: "m-1", text: "第一条" },
      { id: "m-2", text: "第二条" },
      { id: "m-3", text: "第三条" },
      { id: "m-4", text: "第四条" }
    ],
    hasMore: false,
    nextCursor: null,
    loadError: null
  });
});

test("console chat history: load errors keep the current messages intact", () => {
  const current = createConsoleChatHistoryState<FakeMessage>({
    items: [{ id: "m-1", text: "第一条" }],
    hasMore: true,
    nextCursor: "cursor-1",
    loadError: null
  });

  const next = applyConsoleChatHistoryLoadError(current, "历史加载失败，继续上滑重试");

  assert.deepEqual(next, {
    items: [{ id: "m-1", text: "第一条" }],
    hasMore: true,
    nextCursor: "cursor-1",
    loadError: "历史加载失败，继续上滑重试"
  });
});

test("console chat history: reset clears items and pagination state", () => {
  const reset = resetConsoleChatHistoryState<FakeMessage>();

  assert.deepEqual(reset, {
    items: [],
    hasMore: false,
    nextCursor: null,
    loadError: null
  });
});
