import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { CompanionPaths } from "../storage/paths.js";
import { ScheduledTaskStore } from "../storage/scheduled-task-store.js";
import { ScheduledTaskService } from "../services/scheduled-tasks.js";
import { DEFAULT_CONFIG, type AppConfig } from "@shared/types";
import type { ToolDefinition } from "../tools/types.js";

function cloneConfig(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

async function createTempPaths(prefix: string): Promise<CompanionPaths> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const paths = new CompanionPaths(baseDir);
  paths.ensureLayout();
  return paths;
}

function toLocalDateTimeInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

function createToolRegistryStub(definitions: ToolDefinition<any>[], executions: Array<{ name: string; params: Record<string, unknown> }>) {
  return {
    list: () => definitions,
    execute: async (name: string, params: Record<string, unknown>) => {
      executions.push({ name, params });
      return {
        success: true,
        data: { ok: true }
      };
    }
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

test("ScheduledTaskService: creates notify task and run-now dispatches notification", async () => {
  const paths = await createTempPaths("yobi-scheduler-notify-");
  const config = cloneConfig();
  const notifications: string[] = [];
  const executions: Array<{ name: string; params: Record<string, unknown> }> = [];
  const service = new ScheduledTaskService({
    store: new ScheduledTaskStore(paths),
    toolRegistry: createToolRegistryStub([], executions),
    approvalGuard: {
      ensureApproved: async () => true
    } as any,
    getConfig: () => config,
    notify: async (input) => {
      notifications.push(input.text);
    }
  });

  try {
    await service.init();
    const task = await service.saveTask({
      name: "提醒喝水",
      trigger: {
        kind: "once",
        runAt: toLocalDateTimeInput(new Date(Date.now() + 60_000))
      },
      action: {
        kind: "notify",
        text: "去喝水"
      },
      enabled: true
    });

    const run = await service.runTaskNow(task.id);
    const latestTask = service.listTasks()[0];

    assert.equal(notifications[0], "去喝水");
    assert.equal(executions.length, 0);
    assert.equal(run.status, "success");
    assert.equal(latestTask?.status, "completed");
  } finally {
    await service.stop();
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});

test("ScheduledTaskService: once task auto-runs at due time", async () => {
  const paths = await createTempPaths("yobi-scheduler-once-due-");
  const config = cloneConfig();
  const notifications: string[] = [];
  const executions: Array<{ name: string; params: Record<string, unknown> }> = [];
  const service = new ScheduledTaskService({
    store: new ScheduledTaskStore(paths),
    toolRegistry: createToolRegistryStub([], executions),
    approvalGuard: {
      ensureApproved: async () => true
    } as any,
    getConfig: () => config,
    notify: async (input) => {
      notifications.push(input.text);
    }
  });

  try {
    await service.init();
    const task = await service.saveTask({
      name: "自动触发提醒",
      trigger: {
        kind: "once",
        runAt: toLocalDateTimeInput(new Date(Date.now() + 2_000))
      },
      action: {
        kind: "notify",
        text: "到点提醒"
      },
      enabled: true
    });

    await service.start();
    await sleep(4_000);
    await service.stop();

    const latestTask = service.listTasks().find((item) => item.id === task.id);
    assert.equal(notifications.includes("到点提醒"), true);
    assert.equal(executions.length, 0);
    assert.equal(latestTask?.status, "completed");
    assert.equal(latestTask?.lastRunStatus, "success");
  } finally {
    await service.stop();
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});

test("ScheduledTaskService: validates cron and marks past once tasks as missed on start", async () => {
  const paths = await createTempPaths("yobi-scheduler-cron-");
  const config = cloneConfig();
  const notifications: string[] = [];
  const executions: Array<{ name: string; params: Record<string, unknown> }> = [];
  const service = new ScheduledTaskService({
    store: new ScheduledTaskStore(paths),
    toolRegistry: createToolRegistryStub([], executions),
    approvalGuard: {
      ensureApproved: async () => true
    } as any,
    getConfig: () => config,
    notify: async (input) => {
      notifications.push(input.text);
    }
  });

  try {
    await service.init();

    const cronTask = await service.saveTask({
      trigger: {
        kind: "cron",
        expression: "0 9 * * *",
        timezone: "local"
      },
      action: {
        kind: "notify",
        text: "早上好"
      },
      enabled: true
    });
    assert.ok(cronTask.nextRunAt);

    await assert.rejects(
      () =>
        service.saveTask({
          name: "过去任务",
          trigger: {
            kind: "once",
            runAt: toLocalDateTimeInput(new Date(Date.now() - 60_000))
          },
          action: {
            kind: "notify",
            text: "已经过去"
          },
          enabled: true
        }),
      /一次性任务时间必须晚于当前本地时间/
    );

    await assert.rejects(
      () =>
        service.saveTask({
          trigger: {
            kind: "cron",
            expression: "bad cron",
            timezone: "local"
          },
          action: {
            kind: "notify",
            text: "不会保存"
          },
          enabled: true
        }),
      /Cron 表达式必须是 5 段|Invalid expression/
    );

    const store = service["input"].store as ScheduledTaskStore;
    await store.save({
      id: "recent-missed",
      name: "补偿任务",
      trigger: {
        kind: "once",
        runAt: toLocalDateTimeInput(new Date(Date.now() - 6 * 60_000))
      },
      action: {
        kind: "notify",
        text: "最近错过但应补跑"
      },
      status: "enabled",
      nextRunAt: toLocalDateTimeInput(new Date(Date.now() - 6 * 60_000)),
      lastRunAt: null,
      lastRunStatus: null,
      lastRunMessage: null,
      pauseReason: null,
      consecutiveFailures: 0,
      approvalRequiredAtCreation: false,
      approvalSignature: null,
      approvedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    await store.save({
      id: "old-missed",
      name: "超时任务",
      trigger: {
        kind: "once",
        runAt: toLocalDateTimeInput(new Date(Date.now() - 10 * 60_000))
      },
      action: {
        kind: "notify",
        text: "已经过期"
      },
      status: "enabled",
      nextRunAt: toLocalDateTimeInput(new Date(Date.now() - 10 * 60_000)),
      lastRunAt: null,
      lastRunStatus: null,
      lastRunMessage: null,
      pauseReason: null,
      consecutiveFailures: 0,
      approvalRequiredAtCreation: false,
      approvalSignature: null,
      approvedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    await service.start();
    await service.stop();

    assert.equal(notifications.includes("最近错过但应补跑"), false);
    assert.equal(notifications.includes("已经过期"), false);
    const tasks = service.listTasks();
    assert.equal(tasks.find((task) => task.name === "补偿任务")?.status, "missed");
    assert.equal(tasks.find((task) => task.name === "超时任务")?.status, "missed");
  } finally {
    await service.stop();
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});

test("ScheduledTaskService: pauses tool task when approval signature is invalidated", async () => {
  const paths = await createTempPaths("yobi-scheduler-approval-");
  const config = cloneConfig();
  config.tools.system.enabled = true;
  config.tools.system.execEnabled = true;
  const notifications: string[] = [];
  const executions: Array<{ name: string; params: Record<string, unknown> }> = [];

  const systemTool: ToolDefinition<{ action: "exec"; command: string }> = {
    name: "system",
    source: "builtin",
    description: "test system",
    parameters: z.object({
      action: z.literal("exec"),
      command: z.string().min(1)
    }),
    isEnabled: () => true,
    requiresApproval: () => true,
    approvalText: ({ command }) => `执行命令:\n${command}`,
    signatureKey: ({ command }) => command,
    execute: async () => ({
      success: true,
      data: { ok: true }
    })
  };

  const store = new ScheduledTaskStore(paths);
  const service = new ScheduledTaskService({
    store,
    toolRegistry: createToolRegistryStub([systemTool], executions),
    approvalGuard: {
      ensureApproved: async () => true
    } as any,
    getConfig: () => config,
    notify: async (input) => {
      notifications.push(input.text);
    }
  });

  try {
    await service.init();
    const created = await service.saveTask({
      trigger: {
        kind: "once",
        runAt: toLocalDateTimeInput(new Date(Date.now() + 60_000))
      },
      action: {
        kind: "tool",
        toolName: "system",
        params: {
          action: "exec",
          command: "echo hi"
        }
      },
      enabled: true
    });

    await store.save({
      ...created,
      approvalSignature: "system:changed"
    });

    const run = await service.runTaskNow(created.id);
    const task = service.listTasks().find((item) => item.id === created.id);

    assert.equal(run.status, "failed");
    assert.equal(task?.status, "paused");
    assert.equal(task?.pauseReason, "approval-invalidated");
    assert.equal(executions.length, 0);
    assert.equal(notifications.length, 0);
  } finally {
    await service.stop();
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});

test("ScheduledTaskService: rejects legacy ISO once inputs", async () => {
  const paths = await createTempPaths("yobi-scheduler-legacy-once-");
  const config = cloneConfig();
  const executions: Array<{ name: string; params: Record<string, unknown> }> = [];
  const service = new ScheduledTaskService({
    store: new ScheduledTaskStore(paths),
    toolRegistry: createToolRegistryStub([], executions),
    approvalGuard: {
      ensureApproved: async () => true
    } as any,
    getConfig: () => config,
    notify: async () => undefined
  });

  try {
    await service.init();
    await assert.rejects(
      () =>
        service.saveTask({
          trigger: {
            kind: "once",
            runAt: new Date(Date.now() + 60_000).toISOString()
          },
          action: {
            kind: "notify",
            text: "旧格式提醒"
          },
          enabled: true
        }),
      /执行时间不是合法本地时间/
    );
  } finally {
    await service.stop();
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});
