import test from "node:test";
import assert from "node:assert/strict";
import {
  completeConsoleReply,
  emitConsoleFinal,
  runConsolePostReplyTasks,
  type ConsoleRequestHandleState
} from "../runtime/console-chat-lifecycle.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve,
    reject
  };
}

function createHandle(): ConsoleRequestHandleState {
  return {
    finalized: false,
    finalEventEmitted: false
  };
}

test("completeConsoleReply emits final immediately and leaves post-reply work in background", async () => {
  const events: string[] = [];
  const ingestionGate = createDeferred<void>();
  const handle = createHandle();
  let kernelCalls = 0;

  completeConsoleReply({
    requestId: "req-1",
    handle,
    visibleReply: "整理好了",
    userText: "你好",
    emitFinal: (requestId, eventHandle, finishReason, displayText) => {
      events.push(`final:${requestId}:${finishReason}:${displayText}`);
      emitConsoleFinal({
        requestId,
        handle: eventHandle,
        finishReason,
        displayText,
        emit: () => {}
      });
    },
    emitPetTalkingReply: (text) => {
      events.push(`pet:${text}`);
    },
    runPostReplyTasks: async () => {
      events.push("post:start");
      await ingestionGate.promise;
      events.push("post:end");
      kernelCalls += 1;
    }
  });

  assert.equal(handle.finalized, true);
  assert.equal(handle.finishReason, "completed");
  assert.deepEqual(events, [
    "final:req-1:completed:整理好了",
    "pet:整理好了",
    "post:start"
  ]);
  assert.equal(kernelCalls, 0);

  ingestionGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, [
    "final:req-1:completed:整理好了",
    "pet:整理好了",
    "post:start",
    "post:end"
  ]);
  assert.equal(kernelCalls, 1);
});

test("runConsolePostReplyTasks swallows ingestion failures and skips later callbacks", async () => {
  const warnings: unknown[] = [];
  let kernelCalls = 0;
  let statusCalls = 0;

  await runConsolePostReplyTasks({
    channel: "console",
    userText: "你好",
    assistantText: "整理好了",
    ingestDialogue: async () => {
      throw new Error("schema mismatch");
    },
    onAssistantMessage: async () => {
      kernelCalls += 1;
    },
    emitStatus: async () => {
      statusCalls += 1;
    },
    warn: (...args) => {
      warnings.push(args);
    }
  });

  assert.equal(kernelCalls, 0);
  assert.equal(statusCalls, 0);
  assert.equal(warnings.length, 1);
});
