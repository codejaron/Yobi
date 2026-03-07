import test from "node:test";
import assert from "node:assert/strict";
import { assertUniqueQueueHandlerTypes } from "../kernel/engine.js";
import type { PendingTask } from "@shared/types";
import type { KernelQueueTaskHandler } from "../kernel/task-handlers.js";

function createHandler(type: KernelQueueTaskHandler["type"]): KernelQueueTaskHandler {
  return {
    type,
    async handle(_task: PendingTask) {
      return;
    }
  };
}

test("assertUniqueQueueHandlerTypes: unique types pass", () => {
  const handlers: KernelQueueTaskHandler[] = [
    createHandler("fact-extraction"),
    createHandler("daily-episode"),
    createHandler("profile-semantic-update"),
    createHandler("daily-reflection")
  ];

  assert.doesNotThrow(() => {
    assertUniqueQueueHandlerTypes(handlers);
  });
});

test("assertUniqueQueueHandlerTypes: duplicate type throws", () => {
  const handlers: KernelQueueTaskHandler[] = [
    createHandler("fact-extraction"),
    createHandler("fact-extraction")
  ];

  assert.throws(() => {
    assertUniqueQueueHandlerTypes(handlers);
  }, /duplicate-kernel-task-handler:fact-extraction/);
});
