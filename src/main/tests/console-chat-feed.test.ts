import test from "node:test";
import assert from "node:assert/strict";
import {
  reconcileTransientConsoleChatFeedMessages,
  updateAssistantConsoleChatFeedMessageIfPresent,
  upsertAssistantConsoleChatFeedMessage,
  type ConsoleChatFeedMessage
} from "@shared/console-chat-feed";

function createMessage(
  patch: Partial<ConsoleChatFeedMessage> & Pick<ConsoleChatFeedMessage, "id" | "requestId" | "role" | "text" | "state">
): ConsoleChatFeedMessage {
  return {
    ...patch
  };
}

test("upsertAssistantConsoleChatFeedMessage: updates the existing assistant turn instead of appending a duplicate", () => {
  const messages: ConsoleChatFeedMessage[] = [
    createMessage({
      id: "user-1",
      requestId: "request-1",
      role: "user",
      text: "你好",
      state: "done"
    }),
    createMessage({
      id: "assistant-1",
      requestId: "request-1",
      role: "assistant",
      text: "在的",
      state: "streaming"
    })
  ];

  const next = upsertAssistantConsoleChatFeedMessage(
    messages,
    "request-1",
    (current) => ({
      ...current,
      text: `${current.text}，继续说`,
      state: "done"
    }),
    (requestId) =>
      createMessage({
        id: "assistant-new",
        requestId,
        role: "assistant",
        text: "",
        state: "streaming"
      })
  );

  assert.equal(next.length, 2);
  assert.equal(next[1]?.id, "assistant-1");
  assert.equal(next[1]?.text, "在的，继续说");
  assert.equal(next[1]?.state, "done");
});

test("updateAssistantConsoleChatFeedMessageIfPresent: can remove an empty aborted assistant placeholder", () => {
  const messages: ConsoleChatFeedMessage[] = [
    createMessage({
      id: "assistant-1",
      requestId: "request-1",
      role: "assistant",
      text: "",
      state: "streaming"
    })
  ];

  const next = updateAssistantConsoleChatFeedMessageIfPresent(messages, "request-1", () => null);

  assert.deepEqual(next, []);
});

test("reconcileTransientConsoleChatFeedMessages: keeps one list while refreshing voice transient turns in place", () => {
  const current: ConsoleChatFeedMessage[] = [
    createMessage({
      id: "history-user-1",
      requestId: "history-1",
      role: "user",
      text: "旧消息",
      state: "done"
    }),
    createMessage({
      id: "voice-live:1:user",
      requestId: "voice-request-1",
      role: "user",
      text: "你好",
      state: "done",
      transientOrigin: "voice"
    }),
    createMessage({
      id: "voice-live:1:assistant",
      requestId: "voice-request-1",
      role: "assistant",
      text: "收到",
      state: "streaming",
      transientOrigin: "voice"
    })
  ];

  const next = reconcileTransientConsoleChatFeedMessages(current, [
    createMessage({
      id: "voice-live:1:user",
      requestId: "voice-request-1",
      role: "user",
      text: "你好",
      state: "done",
      transientOrigin: "voice"
    }),
    createMessage({
      id: "voice-live:1:assistant",
      requestId: "voice-request-1",
      role: "assistant",
      text: "收到，我在。",
      state: "done",
      transientOrigin: "voice"
    }),
    createMessage({
      id: "voice-live:2:user",
      requestId: "voice-request-2",
      role: "user",
      text: "第二轮",
      state: "streaming",
      transientOrigin: "voice"
    })
  ]);

  assert.equal(next.length, 4);
  assert.equal(next[0]?.id, "history-user-1");
  assert.equal(next[1]?.id, "voice-live:1:user");
  assert.equal(next[2]?.id, "voice-live:1:assistant");
  assert.equal(next[2]?.text, "收到，我在。");
  assert.equal(next[2]?.state, "done");
  assert.equal(next[3]?.id, "voice-live:2:user");
});
