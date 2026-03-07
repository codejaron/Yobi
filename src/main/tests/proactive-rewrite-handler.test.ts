import test from "node:test";
import assert from "node:assert/strict";
import type { AppConfig, EmotionalState } from "@shared/types";
import type { BackgroundTaskWorkerService } from "@main/services/background-task-worker";
import { WorkerProactiveRewriteHandler } from "../kernel/task-handlers.js";

const baseEmotional: EmotionalState = {
  mood: 0,
  energy: 0.5,
  connection: 0.5,
  curiosity: 0.5,
  confidence: 0.5,
  irritation: 0.1
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
  const fakeWorker = {
    getStatus: () => ({
      available: true,
      message: "ready"
    }),
    runProactiveRewrite: async () => ({
      rewrittenMessage: "  改写后的消息  "
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

  assert.equal(rewritten, "改写后的消息");
  assert.equal(handler.getPauseReason(), null);
});
