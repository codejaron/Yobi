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

function createBuiltinToolDefinitions(...names: string[]): ToolDefinition<any>[] {
  return names.map((name) => ({
    name,
    source: "builtin",
    description: `${name} tool`,
    parameters: z.object({}).passthrough(),
    isEnabled: () => true,
    execute: async () => ({
      success: true
    })
  }));
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
    toolRegistry: createToolRegistryStub(createBuiltinToolDefinitions("web_search", "web_fetch"), executions),
    approvalGuard: {
      ensureApproved: async () => true
    } as any,
    getConfig: () => config,
    notify: async (input) => {
      notifications.push(input.text);
    },
    runAgentTask: async () => {
      throw new Error("should not run agent");
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
    },
    runAgentTask: async () => {
      throw new Error("should not run agent");
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
    },
    runAgentTask: async () => {
      throw new Error("should not run agent");
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

test("ScheduledTaskService: runs agent task and stores reply summary", async () => {
  const paths = await createTempPaths("yobi-scheduler-agent-");
  const config = cloneConfig();
  const notifications: string[] = [];
  const executions: Array<{ name: string; params: Record<string, unknown> }> = [];
  const agentRuns: Array<{
    prompt: string;
    allowedToolNames: string[];
    pushTargets?: {
      telegram: boolean;
      feishu: boolean;
    };
  }> = [];
  const service = new ScheduledTaskService({
    store: new ScheduledTaskStore(paths),
    toolRegistry: createToolRegistryStub(createBuiltinToolDefinitions("web_search", "web_fetch"), executions),
    approvalGuard: {
      ensureApproved: async () => true
    } as any,
    getConfig: () => config,
    notify: async (input) => {
      notifications.push(input.text);
    },
    runAgentTask: async (input) => {
      agentRuns.push({
        prompt: input.prompt,
        allowedToolNames: input.allowedToolNames,
        pushTargets: input.pushTargets
      });
      return {
        replyText: "这是今晚的 GitHub Trending 总结：项目 A 做 agent 框架，项目 B 做构建工具。"
      };
    }
  });

  try {
    await service.init();
    const created = await service.saveTask({
      name: "晚间趋势总结",
      trigger: {
        kind: "once",
        runAt: toLocalDateTimeInput(new Date(Date.now() + 60_000))
      },
      action: {
        kind: "agent",
        prompt: "搜索 GitHub Trending 前十，并说明每个项目是做什么的。",
        allowedTools: ["web_search", "web_fetch"],
        pushTargets: {
          telegram: true,
          feishu: false
        }
      },
      enabled: true
    });

    const run = await service.runTaskNow(created.id);
    const task = service.listTasks().find((item) => item.id === created.id);

    assert.equal(run.status, "success");
    assert.equal(task?.status, "completed");
    assert.equal(task?.lastRunStatus, "success");
    assert.match(task?.lastRunMessage ?? "", /GitHub Trending 总结/);
    assert.match(run.message ?? "", /GitHub Trending 总结/);
    assert.deepEqual(agentRuns, [
      {
        prompt: "搜索 GitHub Trending 前十，并说明每个项目是做什么的。",
        allowedToolNames: ["web_fetch", "web_search"],
        pushTargets: {
          telegram: true,
          feishu: false
        }
      }
    ]);
    assert.equal(executions.length, 0);
    assert.equal(notifications.length, 0);
  } finally {
    await service.stop();
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});

test("ScheduledTaskService: requests approval when agent task enables system tool", async () => {
  const paths = await createTempPaths("yobi-scheduler-agent-approval-");
  const config = cloneConfig();
  config.tools.system.enabled = true;
  config.tools.system.execEnabled = true;
  let approvalCalls = 0;

  const service = new ScheduledTaskService({
    store: new ScheduledTaskStore(paths),
    toolRegistry: createToolRegistryStub(
      [
        ...createBuiltinToolDefinitions("web_search"),
        {
          name: "system",
          source: "builtin",
          description: "test system",
          parameters: z.object({}),
          isEnabled: () => true,
          requiresApproval: () => true,
          execute: async () => ({ success: true })
        } as any
      ],
      []
    ),
    approvalGuard: {
      ensureApproved: async (request: { toolName: string; signature: string }) => {
        approvalCalls += 1;
        assert.equal(request.toolName, "agent");
        assert.match(request.signature, /agent:system,web_search/);
        return true;
      }
    } as any,
    getConfig: () => config,
    notify: async () => undefined,
    runAgentTask: async () => ({ replyText: "ok" })
  });

  try {
    await service.init();
    const task = await service.saveTask({
      trigger: {
        kind: "once",
        runAt: toLocalDateTimeInput(new Date(Date.now() + 60_000))
      },
      action: {
        kind: "agent",
        prompt: "帮我整理桌面窗口。",
        allowedTools: ["web_search", "system"]
      },
      enabled: true
    });

    assert.equal(approvalCalls, 1);
    assert.equal(task.approvalRequiredAtCreation, true);
    assert.equal(task.approvalSignature, "agent:system,web_search");
    assert.ok(task.approvedAt);
  } finally {
    await service.stop();
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});

test("ScheduledTaskService: skips approval for safe agent tool set", async () => {
  const paths = await createTempPaths("yobi-scheduler-agent-safe-");
  const config = cloneConfig();
  let approvalCalls = 0;
  const service = new ScheduledTaskService({
    store: new ScheduledTaskStore(paths),
    toolRegistry: createToolRegistryStub(
      createBuiltinToolDefinitions("browser", "web_search", "web_fetch", "code_search"),
      []
    ),
    approvalGuard: {
      ensureApproved: async () => {
        approvalCalls += 1;
        return true;
      }
    } as any,
    getConfig: () => config,
    notify: async () => undefined,
    runAgentTask: async () => ({ replyText: "ok" })
  });

  try {
    await service.init();
    const task = await service.saveTask({
      trigger: {
        kind: "once",
        runAt: toLocalDateTimeInput(new Date(Date.now() + 60_000))
      },
      action: {
        kind: "agent",
        prompt: "搜索今日技术趋势。",
        allowedTools: ["browser", "web_search", "web_fetch", "code_search"]
      },
      enabled: true
    });

    assert.equal(approvalCalls, 0);
    assert.equal(task.approvalRequiredAtCreation, false);
    assert.equal(task.approvalSignature, null);
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
    notify: async () => undefined,
    runAgentTask: async () => ({ replyText: "ok" })
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

test("ScheduledTaskStore: drops legacy tool tasks during init", async () => {
  const paths = await createTempPaths("yobi-scheduler-cleanup-");

  try {
    await fs.writeFile(
      paths.scheduledTasksPath,
      JSON.stringify(
        {
          tasks: [
            {
              id: "legacy-tool-task",
              name: "旧工具任务",
              trigger: {
                kind: "once",
                runAt: toLocalDateTimeInput(new Date(Date.now() + 60_000))
              },
              action: {
                kind: "tool",
                toolName: "web_search",
                params: {
                  query: "legacy"
                }
              },
              status: "enabled",
              nextRunAt: toLocalDateTimeInput(new Date(Date.now() + 60_000)),
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
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const store = new ScheduledTaskStore(paths);
    await store.init();

    assert.equal(store.list().length, 0);
    const saved = JSON.parse(await fs.readFile(paths.scheduledTasksPath, "utf8")) as {
      tasks: unknown[];
    };
    assert.deepEqual(saved.tasks, []);
  } finally {
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});
