import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultEmotionalState, type AppConfig, type EmotionalState } from "@shared/types";
import type { BackgroundTaskWorkerService } from "@main/services/background-task-worker";
import { WorkerProactiveRewriteHandler } from "../kernel/task-handlers.js";

const baseEmotional: EmotionalState = {
  ...createDefaultEmotionalState("familiar"),
  connection: 0.5
};

test("WorkerProactiveRewriteHandler: skips rewrite when worker unavailable", async () => {
  let called = false;
  const fakeWorker = {
    getStatus: () => ({
      available: false,
      message: "worker-exited"
    }),
    runProactiveRewrite: async () => {
      called = true;
      return {
        rewrittenMessage: "ignored"
      };
    }
  } as unknown as BackgroundTaskWorkerService;

  const handler = new WorkerProactiveRewriteHandler({
    getConfig: () => ({}) as AppConfig,
    backgroundWorker: fakeWorker,
    timeoutMs: 20
  });

  const rewritten = await handler.rewrite({
    message: "你好呀",
    stage: "familiar",
    emotional: baseEmotional
  });

  assert.equal(rewritten, null);
  assert.equal(called, false);
  assert.equal(handler.getPauseReason(), "background-worker-unavailable");
});

test("WorkerProactiveRewriteHandler: returns rewritten text from worker", async () => {
  let receivedInput: Record<string, unknown> | null = null;
  const fakeWorker = {
    getStatus: () => ({
      available: true,
      message: "ready"
    }),
    runProactiveRewrite: async (input: Record<string, unknown>) => {
      receivedInput = input;
      return {
      rewrittenMessage: "  改写后的消息  "
      };
    }
  } as unknown as BackgroundTaskWorkerService;

  const handler = new WorkerProactiveRewriteHandler({
    getConfig: () => ({}) as AppConfig,
    backgroundWorker: fakeWorker,
    timeoutMs: 20
  });

  const rewritten = await handler.rewrite({
    message: "原始消息",
    stage: "familiar",
    emotional: baseEmotional,
    recentHistory: [
      {
        role: "user",
        text: "前一条消息",
        timestamp: "2026-03-09T10:00:00.000Z",
        proactive: false
      }
    ],
    lastProactiveAt: "2026-03-09T08:00:00.000Z",
    lastUserMessageAt: "2026-03-09T09:00:00.000Z",
    now: "2026-03-09T12:00:00.000Z"
  });

  assert.equal(rewritten, "改写后的消息");
  assert.equal(handler.getPauseReason(), null);
  assert.deepEqual(receivedInput, {
    message: "原始消息",
    stage: "familiar",
    emotional: baseEmotional,
    recentHistory: [
      {
        role: "user",
        text: "前一条消息",
        timestamp: "2026-03-09T10:00:00.000Z",
        proactive: false
      }
    ],
    lastProactiveAt: "2026-03-09T08:00:00.000Z",
    lastUserMessageAt: "2026-03-09T09:00:00.000Z",
    now: "2026-03-09T12:00:00.000Z",
    config: {}
  });
});

test("WorkerProactiveRewriteHandler: treats empty rewrite as do not send", async () => {
  const fakeWorker = {
    getStatus: () => ({
      available: true,
      message: "ready"
    }),
    runProactiveRewrite: async () => ({
      rewrittenMessage: "   "
    })
  } as unknown as BackgroundTaskWorkerService;

  const handler = new WorkerProactiveRewriteHandler({
    getConfig: () => ({}) as AppConfig,
    backgroundWorker: fakeWorker,
    timeoutMs: 20
  });

  const rewritten = await handler.rewrite({
    message: "原始消息",
    stage: "familiar",
    emotional: baseEmotional
  });

  assert.equal(rewritten, "");
});
