import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import type {
  AppConfig,
  ScheduledTask,
  ScheduledTaskAction,
  ScheduledTaskInput,
  ScheduledTaskRun,
  ScheduledTaskStatus,
  ScheduledTaskToolName,
  ScheduledTaskTrigger
} from "@shared/types";
import type { ApprovalGuard } from "@main/tools/guard/approval";
import type { ScheduledTaskStore } from "@main/storage/scheduled-task-store";
import type { ToolApprovalHandler, ToolDefinition, ToolRegistry } from "@main/tools/types";

interface ScheduledTaskNotifyInput {
  text: string;
  pushTargets?: {
    telegram: boolean;
    feishu: boolean;
  };
}

interface ScheduledTaskAgentRunInput {
  taskId: string;
  taskName: string;
  prompt: string;
  allowedToolNames: ScheduledTaskToolName[];
  pushTargets?: {
    telegram: boolean;
    feishu: boolean;
  };
}

interface ScheduledTaskServiceInput {
  store: ScheduledTaskStore;
  toolRegistry: Pick<ToolRegistry, "list">;
  approvalGuard: ApprovalGuard;
  getConfig: () => AppConfig;
  notify: (input: ScheduledTaskNotifyInput) => Promise<void>;
  runAgentTask: (input: ScheduledTaskAgentRunInput) => Promise<{ replyText: string }>;
}

const GRACE_WINDOW_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 1_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const AGENT_APPROVAL_REQUIRED_TOOLS = new Set<ScheduledTaskToolName>(["system", "file"]);

function resolveLocalTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function normalizeCronExpression(expression: string): string {
  const normalized = expression.trim().replace(/\s+/g, " ");
  const parts = normalized.split(" ").filter(Boolean);
  if (parts.length !== 5) {
    throw new Error("Cron 表达式必须是 5 段：分 时 日 月 周");
  }
  return `0 ${parts.join(" ")}`;
}

function parseIsoDate(value: string, label: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label}不是合法时间`);
  }
  return date;
}

function padTwo(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocalDateTime(date: Date): string {
  return `${date.getFullYear()}-${padTwo(date.getMonth() + 1)}-${padTwo(date.getDate())}T${padTwo(date.getHours())}:${padTwo(date.getMinutes())}:${padTwo(date.getSeconds())}`;
}

function parseLocalDateTime(value: string, label: string): Date {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label}不能为空`);
  }

  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    throw new Error(`${label}不是合法本地时间`);
  }

  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? "0"),
    0
  );

  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label}不是合法本地时间`);
  }

  return date;
}

function normalizeLocalDateTime(value: string, label: string): string {
  return formatLocalDateTime(parseLocalDateTime(value, label));
}

function parseScheduledLocalDate(value: string, label: string): Date {
  return parseLocalDateTime(value, label);
}

function nowIso(): string {
  return new Date().toISOString();
}

function cloneTask(task: ScheduledTask): ScheduledTask {
  return JSON.parse(JSON.stringify(task)) as ScheduledTask;
}

function dedupeToolNames(names: ScheduledTaskToolName[]): ScheduledTaskToolName[] {
  return Array.from(new Set(names)).sort();
}

function summarizeAgentReply(replyText: string, limit = 200): string {
  const normalized = replyText.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "执行成功";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

export class ScheduledTaskService {
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly activeTaskIds = new Set<string>();

  constructor(private readonly input: ScheduledTaskServiceInput) {}

  async init(): Promise<void> {
    await this.input.store.init();
    await this.refreshOnceTaskNextRuns();
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    await this.refreshOnceTaskNextRuns();
    await this.processDueTasks();
    this.scheduleNextTick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  listTasks(): ScheduledTask[] {
    return this.input.store.list();
  }

  async listRuns(input?: { limit?: number; taskId?: string }): Promise<ScheduledTaskRun[]> {
    return this.input.store.listRuns(input);
  }

  async getSnapshot(): Promise<{ tasks: ScheduledTask[]; runs: ScheduledTaskRun[] }> {
    const tasks = this.listTasks();
    const runs = await this.listRuns({ limit: 100 });
    return { tasks, runs };
  }

  async saveTask(
    input: ScheduledTaskInput,
    options: { requestApproval?: ToolApprovalHandler } = {}
  ): Promise<ScheduledTask> {
    const existing = input.id ? this.input.store.get(input.id) : null;
    const now = new Date();
    const name = input.name?.trim() || this.deriveTaskName(input.action);
    if (!name) {
      throw new Error("任务名称不能为空");
    }

    const normalizedTrigger = this.normalizeTrigger(input.trigger);
    const normalizedAction = await this.normalizeAction(input.action, options.requestApproval);
    const enabled = input.enabled ?? existing?.status !== "paused";
    const nextRunAt = this.computeNextRunAt(normalizedTrigger, now);

    if (normalizedTrigger.kind === "once" && !nextRunAt) {
      throw new Error("一次性任务时间必须晚于当前本地时间");
    }

    const task: ScheduledTask = {
      id: existing?.id ?? randomUUID(),
      name,
      trigger: normalizedTrigger,
      action: normalizedAction.action,
      status: enabled ? "enabled" : "paused",
      nextRunAt,
      lastRunAt: existing?.lastRunAt ?? null,
      lastRunStatus: existing?.lastRunStatus ?? null,
      lastRunMessage: existing?.lastRunMessage ?? null,
      pauseReason: enabled ? null : existing?.pauseReason ?? "manual",
      consecutiveFailures: existing?.consecutiveFailures ?? 0,
      approvalRequiredAtCreation: normalizedAction.approvalRequiredAtCreation,
      approvalSignature: normalizedAction.approvalSignature,
      approvedAt: normalizedAction.approvedAt,
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString()
    };

    await this.input.store.save(task);
    return cloneTask(task);
  }

  async pauseTask(id: string): Promise<ScheduledTask> {
    const task = this.requireTask(id);
    const next: ScheduledTask = {
      ...task,
      status: "paused",
      pauseReason: "manual",
      updatedAt: nowIso()
    };
    await this.input.store.save(next);
    return cloneTask(next);
  }

  async resumeTask(id: string): Promise<ScheduledTask> {
    const task = this.requireTask(id);
    const nextRunAt = this.computeNextRunAt(task.trigger, new Date());
    const status: ScheduledTaskStatus = task.trigger.kind === "once" && !nextRunAt ? "missed" : "enabled";
    const next: ScheduledTask = {
      ...task,
      status,
      nextRunAt,
      pauseReason: null,
      updatedAt: nowIso(),
      consecutiveFailures: 0
    };
    await this.input.store.save(next);
    return cloneTask(next);
  }

  async deleteTask(id: string): Promise<{ removed: boolean }> {
    const removed = await this.input.store.remove(id);
    return { removed: Boolean(removed) };
  }

  async runTaskNow(id: string): Promise<ScheduledTaskRun> {
    const task = this.requireTask(id);
    return this.executeTask(task, {
      scheduledFor: task.nextRunAt,
      manual: true
    });
  }

  private scheduleNextTick(): void {
    if (!this.running) {
      return;
    }

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }

    this.pollTimer = setTimeout(() => {
      void this.processDueTasks().finally(() => {
        this.scheduleNextTick();
      });
    }, POLL_INTERVAL_MS);
  }

  private async processDueTasks(): Promise<void> {
    const now = new Date();
    const tasks = this.input.store.list();

    for (const task of tasks) {
      if (task.status !== "enabled") {
        continue;
      }

      if (this.activeTaskIds.has(task.id)) {
        continue;
      }

      if (!task.nextRunAt && task.trigger.kind !== "once") {
        continue;
      }

      let effectiveNextRunAt = task.nextRunAt;
      if (task.trigger.kind === "once" && !effectiveNextRunAt) {
        effectiveNextRunAt = formatLocalDateTime(parseLocalDateTime(task.trigger.runAt, "执行时间"));
        const refreshedTask: ScheduledTask = {
          ...task,
          nextRunAt: effectiveNextRunAt,
          updatedAt: nowIso()
        };
        await this.input.store.save(refreshedTask);
        task.nextRunAt = effectiveNextRunAt;
      }
      if (!effectiveNextRunAt) {
        continue;
      }

      const nextRun = parseScheduledLocalDate(effectiveNextRunAt, "下次执行时间");
      const deltaMs = now.getTime() - nextRun.getTime();
      if (deltaMs < 0) {
        continue;
      }

      if (task.trigger.kind === "once" && deltaMs > GRACE_WINDOW_MS) {
        await this.markMissed(task, task.nextRunAt);
        continue;
      }

      if (task.trigger.kind === "cron" && deltaMs > GRACE_WINDOW_MS) {
        const next: ScheduledTask = {
          ...task,
          nextRunAt: this.computeNextRunAt(task.trigger, now),
          updatedAt: nowIso()
        };
        await this.input.store.save(next);
        continue;
      }

      await this.executeTask(task, {
        scheduledFor: task.nextRunAt,
        manual: false
      });
    }
  }

  private async executeTask(
    task: ScheduledTask,
    input: {
      scheduledFor: string | null;
      manual: boolean;
    }
  ): Promise<ScheduledTaskRun> {
    const current = this.requireTask(task.id);
    if (this.activeTaskIds.has(current.id)) {
      throw new Error("任务正在执行中");
    }

    this.activeTaskIds.add(current.id);
    const startedAt = nowIso();

    try {
      const successMessage = await this.executeAction(current);

      const finishedAt = nowIso();
      const updatedTask = await this.applySuccess(current, input.manual, successMessage);
      const run = await this.input.store.appendRun({
        taskId: current.id,
        taskName: current.name,
        status: "success",
        scheduledFor: input.scheduledFor,
        startedAt,
        finishedAt,
        message: updatedTask.lastRunMessage,
        error: null
      });
      return run;
    } catch (error) {
      const finishedAt = nowIso();
      const message = error instanceof Error ? error.message : "执行失败";
      const updatedTask = await this.applyFailure(current, message, input.manual);
      const run = await this.input.store.appendRun({
        taskId: current.id,
        taskName: current.name,
        status: "failed",
        scheduledFor: input.scheduledFor,
        startedAt,
        finishedAt,
        message: updatedTask.lastRunMessage,
        error: message
      });
      return run;
    } finally {
      this.activeTaskIds.delete(current.id);
    }
  }

  private async executeAction(task: ScheduledTask): Promise<string | null> {
    if (task.action.kind === "notify") {
      await this.input.notify({
        text: task.action.text,
        pushTargets: task.action.pushTargets
      });
      return null;
    }

    if (task.action.kind !== "agent") {
      return null;
    }

    const approvalRequired = this.requiresAgentApproval(task.action.allowedTools);
    if (approvalRequired) {
      const signature = this.computeAgentApprovalSignature(task.action.allowedTools);
      if (!task.approvalSignature || task.approvalSignature !== signature) {
        throw new Error("approval-invalidated");
      }
    }

    const result = await this.input.runAgentTask({
      taskId: task.id,
      taskName: task.name,
      prompt: task.action.prompt,
      allowedToolNames: task.action.allowedTools,
      pushTargets: task.action.pushTargets
    });

    return summarizeAgentReply(result.replyText);
  }

  private async applySuccess(task: ScheduledTask, manual: boolean, successMessage?: string | null): Promise<ScheduledTask> {
    const now = new Date();
    let status: ScheduledTaskStatus = task.status;
    let nextRunAt = task.nextRunAt;

    if (task.trigger.kind === "once") {
      status = "completed";
      nextRunAt = null;
    } else if (!manual) {
      const baseDate = task.nextRunAt ? parseScheduledLocalDate(task.nextRunAt, "下次执行时间") : now;
      nextRunAt = this.computeNextRunAt(task.trigger, baseDate);
    }

    const updated: ScheduledTask = {
      ...task,
      status,
      nextRunAt,
      lastRunAt: now.toISOString(),
      lastRunStatus: "success",
      lastRunMessage: successMessage?.trim() || "执行成功",
      pauseReason: null,
      consecutiveFailures: 0,
      updatedAt: now.toISOString()
    };
    await this.input.store.save(updated);
    return updated;
  }

  private async applyFailure(task: ScheduledTask, errorMessage: string, manual: boolean): Promise<ScheduledTask> {
    const now = new Date();
    const nextFailures = task.consecutiveFailures + 1;
    const shouldPause = errorMessage === "approval-invalidated" || nextFailures >= MAX_CONSECUTIVE_FAILURES;

    let status: ScheduledTaskStatus = task.status;
    let nextRunAt = task.nextRunAt;
    let pauseReason: string | null = null;

    if (task.trigger.kind === "once") {
      status = errorMessage === "approval-invalidated" ? "paused" : "failed";
      nextRunAt = null;
      pauseReason = errorMessage === "approval-invalidated" ? "approval-invalidated" : errorMessage;
    } else if (shouldPause) {
      status = "paused";
      pauseReason = errorMessage === "approval-invalidated" ? "approval-invalidated" : "repeated-failure";
    } else if (!manual) {
      const baseDate = task.nextRunAt ? parseScheduledLocalDate(task.nextRunAt, "下次执行时间") : now;
      nextRunAt = this.computeNextRunAt(task.trigger, baseDate);
    }

    const updated: ScheduledTask = {
      ...task,
      status,
      nextRunAt,
      lastRunAt: now.toISOString(),
      lastRunStatus: "failed",
      lastRunMessage: errorMessage,
      pauseReason,
      consecutiveFailures: nextFailures,
      updatedAt: now.toISOString()
    };
    await this.input.store.save(updated);
    return updated;
  }

  private async markMissed(task: ScheduledTask, scheduledFor: string | null): Promise<void> {
    const now = nowIso();
    const updated: ScheduledTask = {
      ...task,
      status: "missed",
      nextRunAt: null,
      lastRunAt: now,
      lastRunStatus: "missed",
      lastRunMessage: "任务已错过执行窗口",
      updatedAt: now
    };
    await this.input.store.save(updated);
    await this.input.store.appendRun({
      taskId: updated.id,
      taskName: updated.name,
      status: "missed",
      scheduledFor,
      startedAt: now,
      finishedAt: now,
      message: updated.lastRunMessage,
      error: null
    });
  }

  private normalizeTrigger(trigger: ScheduledTaskTrigger): ScheduledTaskTrigger {
    if (trigger.kind === "once") {
      return {
        kind: "once",
        runAt: normalizeLocalDateTime(trigger.runAt, "执行时间")
      };
    }

    const expression = trigger.expression.trim();
    if (!expression) {
      throw new Error("Cron 表达式不能为空");
    }
    this.computeNextRunAt({ kind: "cron", expression, timezone: "local" }, new Date());
    return {
      kind: "cron",
      expression,
      timezone: "local"
    };
  }

  private async normalizeAction(
    action: ScheduledTaskAction,
    requestApproval?: ToolApprovalHandler
  ): Promise<{
    action: ScheduledTaskAction;
    approvalRequiredAtCreation: boolean;
    approvalSignature: string | null;
    approvedAt: string | null;
  }> {
    if (action.kind === "notify") {
      const text = action.text.trim();
      if (!text) {
        throw new Error("提醒内容不能为空");
      }

      return {
        action: {
          kind: "notify",
          text,
          pushTargets: action.pushTargets
        },
        approvalRequiredAtCreation: false,
        approvalSignature: null,
        approvedAt: null
      };
    }

    const prompt = action.prompt.trim();
    if (!prompt) {
      throw new Error("Agent 指令不能为空");
    }

    const allowedTools = dedupeToolNames(action.allowedTools);
    for (const toolName of allowedTools) {
      this.findAllowedToolDefinition(toolName);
    }

    const approvalRequiredAtCreation = this.requiresAgentApproval(allowedTools);
    const approvalSignature = approvalRequiredAtCreation ? this.computeAgentApprovalSignature(allowedTools) : null;
    const approvedAt = approvalRequiredAtCreation ? await this.ensureAgentApproved(allowedTools, approvalSignature!, requestApproval) : null;

    return {
      action: {
        kind: "agent",
        prompt,
        pushTargets: action.pushTargets,
        allowedTools
      },
      approvalRequiredAtCreation,
      approvalSignature,
      approvedAt
    };
  }

  private async ensureAgentApproved(
    allowedTools: ScheduledTaskToolName[],
    signature: string,
    requestApproval?: ToolApprovalHandler
  ): Promise<string> {
    const description = `允许定时 Agent 在无人值守时使用以下工具类别：${allowedTools.join(", ")}`;
    const approved = await this.input.approvalGuard.ensureApproved(
      {
        toolName: "agent",
        params: {
          allowedTools
        },
        description,
        signature
      },
      requestApproval
    );

    if (!approved) {
      throw new Error("用户拒绝了该操作");
    }

    return nowIso();
  }

  private findAllowedToolDefinition(name: ScheduledTaskToolName): ToolDefinition<any> {
    const definition = this.input.toolRegistry
      .list()
      .find((tool) => tool.name === name && tool.source === "builtin");

    if (!definition) {
      throw new Error(`未找到可调度工具: ${name}`);
    }

    const enabled = definition.isEnabled ? definition.isEnabled(this.input.getConfig()) : true;
    if (!enabled) {
      throw new Error(`工具当前未启用: ${name}`);
    }

    return definition;
  }

  private deriveTaskName(action: ScheduledTaskAction): string {
    if (action.kind === "notify") {
      return action.text.trim().slice(0, 24) || "定时提醒";
    }
    return action.prompt.trim().slice(0, 24) || "定时 Agent";
  }

  private requiresAgentApproval(allowedTools: ScheduledTaskToolName[]): boolean {
    return allowedTools.some((toolName) => AGENT_APPROVAL_REQUIRED_TOOLS.has(toolName));
  }

  private computeAgentApprovalSignature(allowedTools: ScheduledTaskToolName[]): string {
    return `agent:${dedupeToolNames(allowedTools).join(",")}`;
  }

  private computeNextRunAt(trigger: ScheduledTaskTrigger, fromDate: Date): string | null {
    if (trigger.kind === "once") {
      const runAt = parseLocalDateTime(trigger.runAt, "执行时间");
      if (runAt.getTime() <= fromDate.getTime()) {
        return null;
      }
      return formatLocalDateTime(runAt);
    }

    const parser = CronExpressionParser.parse(normalizeCronExpression(trigger.expression), {
      currentDate: fromDate,
      tz: resolveLocalTimeZone()
    });
    const next = parser.next().toISOString();
    if (!next) {
      return null;
    }
    return formatLocalDateTime(parseIsoDate(next, "Cron 下一次执行时间"));
  }

  private requireTask(id: string): ScheduledTask {
    const task = this.input.store.get(id);
    if (!task) {
      throw new Error(`未找到任务: ${id}`);
    }
    return cloneTask(task);
  }

  private async refreshOnceTaskNextRuns(): Promise<void> {
    const tasks = this.input.store.list();
    const now = new Date();

    for (const task of tasks) {
      if (task.trigger.kind !== "once") {
        continue;
      }
      if (task.status === "completed" || task.status === "missed" || task.status === "failed") {
        continue;
      }

      const canonicalRunAt = formatLocalDateTime(parseLocalDateTime(task.trigger.runAt, "执行时间"));
      const runAt = parseScheduledLocalDate(canonicalRunAt, "执行时间");
      const deltaMs = now.getTime() - runAt.getTime();

      if (task.status === "enabled" && deltaMs > GRACE_WINDOW_MS) {
        await this.markMissed(task, task.nextRunAt ?? canonicalRunAt);
        continue;
      }

      if (canonicalRunAt === task.nextRunAt) {
        continue;
      }

      await this.input.store.save({
        ...task,
        nextRunAt: canonicalRunAt,
        updatedAt: nowIso()
      });
    }
  }
}
