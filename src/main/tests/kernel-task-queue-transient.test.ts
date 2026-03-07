import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import type { CompanionPaths } from "@main/storage/paths";
import { KernelTaskQueue } from "../kernel/task-queue.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createQueueFixture(): Promise<{
  queue: KernelTaskQueue;
  dir: string;
  pendingTasksPath: string;
  deadLetterTasksPath: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yobi-kernel-queue-"));
  const pendingTasksPath = path.join(dir, "pending-tasks.jsonl");
  const deadLetterTasksPath = path.join(dir, "dead-letter-tasks.jsonl");
  await fs.writeFile(pendingTasksPath, "", "utf8");
  await fs.writeFile(deadLetterTasksPath, "", "utf8");

  const queue = new KernelTaskQueue(
    {
      pendingTasksPath,
      deadLetterTasksPath
    } as CompanionPaths,
    1,
    2
  );
  await queue.init();

  return {
    queue,
    dir,
    pendingTasksPath,
    deadLetterTasksPath
  };
}

test("KernelTaskQueue: worker-unavailable is treated as transient retry", async () => {
  const fixture = await createQueueFixture();
  const { queue } = fixture;

  queue.register("fact-extraction", async () => {
    throw new Error("background-worker-unavailable");
  });
  await queue.enqueue({
    type: "fact-extraction",
    sourceRange: "m1..m2",
    payload: {
      sourceRange: "m1..m2",
      messages: []
    }
  });
  await queue.processAvailable();

  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const task = queue.list()[0];
    if (task && task.status === "pending" && task.attempts === 0 && task.last_error === "background-worker-unavailable") {
      break;
    }
    await sleep(20);
  }

  const [task] = queue.list();
  assert.ok(task, "task should still exist");
  assert.equal(task.status, "pending");
  assert.equal(task.attempts, 0);
  assert.equal(task.last_error, "background-worker-unavailable");
  assert.ok(new Date(task.available_at).getTime() > Date.now());

  const deadLettersRaw = await fs.readFile(fixture.deadLetterTasksPath, "utf8");
  assert.equal(deadLettersRaw.trim(), "");

  await fs.rm(fixture.dir, { recursive: true, force: true });
});
