import { generateObject } from "ai";
import { z } from "zod";
import { readJsonFile, writeJsonFile } from "@main/storage/fs";
import type { AppConfig, HistoryMessage, TopicPoolItem } from "@shared/types";
import type { ModelFactory } from "@main/core/model-factory";
import { resolveOpenAIStoreOption } from "@main/core/provider-utils";
import type { YobiMemory } from "@main/memory/setup";
import type { BilibiliBrowseService } from "@main/services/browse/bilibili-browse-service";
import { reportTokenUsage } from "@main/services/token/token-usage-reporter";

const RECALL_INTERVAL_MS = 3 * 60 * 60 * 1000;
const TASK_CHECK_INTERVAL_MS = 60 * 1000;
const MAX_UNUSED_TOPICS = 10;
const RECALL_DEFAULT_EXPIRES_HOURS = 24;

type BackgroundTaskName = "recall" | "wander";
type RunReason =
  | "interval-not-reached"
  | "running"
  | "disabled"
  | "pool-full"
  | "added"
  | "no-new-topic"
  | "browse-noop"
  | "browse-missing-cookie"
  | "browse-auth-expired"
  | "browse-auth-error"
  | "error";

interface TaskRunOutcome {
  ran: boolean;
  changed: boolean;
  reason: RunReason;
  detail?: string;
}

interface BackgroundTaskRunState {
  recallLastRunAt: string;
  wanderLastRunAt: string;
}

interface BackgroundTaskRunStateDocument {
  recallLastRunAt?: string | null;
  wanderLastRunAt?: string | null;
}

export interface BackgroundTaskTriggerResult {
  accepted: boolean;
  message: string;
}

const recallTopicSchema = z.union([
  z.string().min(1).max(140),
  z.object({
    text: z.string().min(1).max(140),
    expiresInHours: z.number().int().min(1).max(168).optional()
  })
]);

const recallSchema = z.object({
  topics: z.array(recallTopicSchema).max(2).default([])
});

function formatHistory(history: HistoryMessage[]): string {
  if (history.length === 0) {
    return "(空)";
  }

  return history
    .map((item) => {
      const text = item.text.replace(/\s+/g, " ").trim();
      return `[${item.timestamp}] ${item.role}: ${text}`;
    })
    .join("\n");
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) {
    return null;
  }

  return new Date(ms).toISOString();
}

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function formatTopicPool(topics: TopicPoolItem[]): string {
  if (topics.length === 0) {
    return "(空)";
  }

  return topics
    .map((topic, index) => {
      const status = topic.used ? "已使用" : "待触发";
      const expires = topic.expiresAt ? `过期 ${topic.expiresAt}` : "长期";
      return `${index + 1}. [${topic.source}] ${topic.text} | ${status} | ${expires}`;
    })
    .join("\n");
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "未知错误";
}

export class BackgroundTaskService {
  private recallTimer: NodeJS.Timeout | null = null;
  private wanderTimer: NodeJS.Timeout | null = null;
  private recallRunning = false;
  private wanderRunning = false;
  private state: BackgroundTaskRunState | null = null;
  private stateInitPromise: Promise<void> | null = null;

  constructor(
    private readonly modelFactory: ModelFactory,
    private readonly memory: YobiMemory,
    private readonly browse: BilibiliBrowseService,
    private readonly getConfig: () => AppConfig,
    private readonly context: {
      resourceId: string;
      threadId: string;
      statePath: string;
      onTopicPoolUpdated?: () => void | Promise<void>;
    }
  ) {}

  start(): void {
    this.stop();
    this.recallTimer = setInterval(() => {
      void this.runRecallSafe({
        force: false
      });
    }, TASK_CHECK_INTERVAL_MS);

    this.wanderTimer = setInterval(() => {
      void this.runWanderSafe({
        force: false
      });
    }, TASK_CHECK_INTERVAL_MS);

    void this.runScheduledChecks();
  }

  stop(): void {
    if (this.recallTimer) {
      clearInterval(this.recallTimer);
      this.recallTimer = null;
    }

    if (this.wanderTimer) {
      clearInterval(this.wanderTimer);
      this.wanderTimer = null;
    }
  }

  async triggerRecallNow(): Promise<BackgroundTaskTriggerResult> {
    const outcome = await this.runRecallSafe({
      force: true
    });
    return this.toManualTriggerResult("回想", outcome);
  }

  async triggerWanderNow(): Promise<BackgroundTaskTriggerResult> {
    const outcome = await this.runWanderSafe({
      force: true
    });
    return this.toManualTriggerResult("浏览", outcome);
  }

  private async runScheduledChecks(): Promise<void> {
    await this.ensureStateReady();
    await this.runRecallSafe({
      force: false
    });
    await this.runWanderSafe({
      force: false
    });
  }

  private async runRecallSafe(options: {
    force: boolean;
  }): Promise<TaskRunOutcome> {
    await this.ensureStateReady();
    if (this.recallRunning) {
      return {
        ran: false,
        changed: false,
        reason: "running"
      };
    }

    if (!options.force && !this.getConfig().proactive.enabled) {
      return {
        ran: false,
        changed: false,
        reason: "disabled"
      };
    }

    if (!options.force && !this.isTaskDue("recall")) {
      return {
        ran: false,
        changed: false,
        reason: "interval-not-reached"
      };
    }

    this.recallRunning = true;
    try {
      const outcome = await this.runRecall({
        force: options.force
      });
      if (outcome.ran) {
        await this.markTaskRun("recall");
      }
      if (outcome.changed) {
        await this.context.onTopicPoolUpdated?.();
      }
      return outcome;
    } catch (error) {
      await this.markTaskRun("recall");
      const detail = summarizeError(error);
      console.warn("[background] recall failed:", error);
      return {
        ran: true,
        changed: false,
        reason: "error",
        detail
      };
    } finally {
      this.recallRunning = false;
    }
  }

  private async runWanderSafe(options: {
    force: boolean;
  }): Promise<TaskRunOutcome> {
    await this.ensureStateReady();
    if (this.wanderRunning) {
      return {
        ran: false,
        changed: false,
        reason: "running"
      };
    }

    if (!options.force && !this.getConfig().proactive.enabled) {
      return {
        ran: false,
        changed: false,
        reason: "disabled"
      };
    }

    if (!options.force && !this.isTaskDue("wander")) {
      return {
        ran: false,
        changed: false,
        reason: "interval-not-reached"
      };
    }

    this.wanderRunning = true;
    try {
      const outcome = await this.runWander({
        force: options.force
      });
      if (outcome.ran) {
        await this.markTaskRun("wander");
      }
      if (outcome.changed) {
        await this.context.onTopicPoolUpdated?.();
      }
      return outcome;
    } catch (error) {
      await this.markTaskRun("wander");
      const detail = summarizeError(error);
      console.warn("[background] wander failed:", error);
      return {
        ran: true,
        changed: false,
        reason: "error",
        detail
      };
    } finally {
      this.wanderRunning = false;
    }
  }

  private async runRecall(input: {
    force: boolean;
  }): Promise<TaskRunOutcome> {
    const config = this.getConfig();
    if (!config.proactive.enabled && !input.force) {
      return {
        ran: false,
        changed: false,
        reason: "disabled"
      };
    }

    const unusedTopicCount = await this.memory.countUnusedTopics();
    if (unusedTopicCount >= MAX_UNUSED_TOPICS) {
      return {
        ran: false,
        changed: false,
        reason: "pool-full"
      };
    }

    const model = this.modelFactory.getChatModel();
    const workingMemory = await this.memory.getWorkingMemory(this.context);
    const history = await this.memory.listHistory({
      ...this.context,
      limit: 40,
      offset: 0
    });
    const topicPool = await this.memory.listTopicPool(200);

    const systemPrompt = [
      "你负责在后台整理主动聊天候选话题。",
      "只返回 topics 数组，最多 2 条，每条都包含 text，可选 expiresInHours。",
      "在产出前必须回顾已有话题池，避免和任何已有话题重复（含语义重复）。",
      "优先输出可延续、可追问的轻量话题，不要输出敏感或诊断类内容。",
      "如果没有值得主动提起的内容，返回空数组。"
    ].join("\n");
    const userPrompt = [
      `工作记忆:\n${workingMemory.markdown}`,
      `最近历史:\n${formatHistory(history)}`,
      `已有话题池（含已使用）:\n${formatTopicPool(topicPool)}`,
      "请给出 0-2 个一句话话题。"
    ].join("\n\n");

    const result = await generateObject({
      model,
      providerOptions: resolveOpenAIStoreOption(config),
      schema: recallSchema,
      system: systemPrompt,
      prompt: userPrompt
    });

    reportTokenUsage({
      source: "background:recall",
      usage: result.usage,
      systemText: systemPrompt,
      inputText: userPrompt,
      outputText: JSON.stringify(result.object ?? {})
    });

    const topics = recallSchema.parse(result.object ?? { topics: [] }).topics;
    let changed = false;
    for (const topic of topics) {
      const text = typeof topic === "string" ? topic : topic.text;
      const expiresInHours = typeof topic === "string" ? undefined : topic.expiresInHours;
      const inserted = await this.memory.addTopic({
        text,
        source: "recall",
        expiresAt: hoursFromNow(expiresInHours ?? RECALL_DEFAULT_EXPIRES_HOURS)
      });
      changed = changed || inserted;
    }

    return {
      ran: true,
      changed,
      reason: changed ? "added" : "no-new-topic"
    };
  }

  private async runWander(input: {
    force: boolean;
  }): Promise<TaskRunOutcome> {
    const config = this.getConfig();
    if (!config.proactive.enabled && !input.force) {
      return {
        ran: false,
        changed: false,
        reason: "disabled"
      };
    }

    if (!config.browse.enabled && !input.force) {
      return {
        ran: false,
        changed: false,
        reason: "disabled"
      };
    }

    const outcome = await this.browse.runHeartbeat({
      forceDigest: input.force
    });

    if (outcome.reason === "disabled") {
      return {
        ran: false,
        changed: false,
        reason: "disabled"
      };
    }

    if (outcome.reason === "missing-cookie") {
      return {
        ran: true,
        changed: false,
        reason: "browse-missing-cookie",
        detail: outcome.detail
      };
    }

    if (outcome.reason === "auth-expired") {
      return {
        ran: true,
        changed: false,
        reason: "browse-auth-expired",
        detail: outcome.detail
      };
    }

    if (outcome.reason === "auth-error") {
      return {
        ran: true,
        changed: false,
        reason: "browse-auth-error",
        detail: outcome.detail
      };
    }

    if (outcome.reason === "error") {
      return {
        ran: true,
        changed: false,
        reason: "error",
        detail: outcome.detail
      };
    }

    return {
      ran: true,
      changed: outcome.changed,
      reason: outcome.changed ? "added" : "browse-noop",
      detail: outcome.detail
    };
  }

  private async ensureStateReady(): Promise<void> {
    if (this.state) {
      return;
    }

    if (this.stateInitPromise) {
      await this.stateInitPromise;
      return;
    }

    this.stateInitPromise = (async () => {
      const raw = await readJsonFile<BackgroundTaskRunStateDocument>(this.context.statePath, {});
      const now = new Date().toISOString();
      const recallLastRunAt = normalizeTimestamp(raw.recallLastRunAt) ?? now;
      const wanderLastRunAt = normalizeTimestamp(raw.wanderLastRunAt) ?? now;
      this.state = {
        recallLastRunAt,
        wanderLastRunAt
      };
      await this.persistState();
    })().finally(() => {
      this.stateInitPromise = null;
    });

    await this.stateInitPromise;
  }

  private async persistState(): Promise<void> {
    if (!this.state) {
      return;
    }

    await writeJsonFile<BackgroundTaskRunStateDocument>(this.context.statePath, {
      recallLastRunAt: this.state.recallLastRunAt,
      wanderLastRunAt: this.state.wanderLastRunAt
    });
  }

  private isTaskDue(task: BackgroundTaskName): boolean {
    if (!this.state) {
      return false;
    }

    const lastRunAt = task === "recall" ? this.state.recallLastRunAt : this.state.wanderLastRunAt;
    const elapsed = Date.now() - new Date(lastRunAt).getTime();
    if (task === "recall") {
      return elapsed >= RECALL_INTERVAL_MS;
    }

    const interval = Math.max(60_000, this.getConfig().browse.eventCheckIntervalMs);
    return elapsed >= interval;
  }

  private async markTaskRun(task: BackgroundTaskName): Promise<void> {
    if (!this.state) {
      return;
    }

    const now = new Date().toISOString();
    if (task === "recall") {
      this.state.recallLastRunAt = now;
    } else {
      this.state.wanderLastRunAt = now;
    }
    await this.persistState();
  }

  private toManualTriggerResult(taskLabel: "回想" | "浏览", outcome: TaskRunOutcome): BackgroundTaskTriggerResult {
    if (outcome.reason === "running") {
      return {
        accepted: false,
        message: `${taskLabel}任务正在执行，请稍后再试。`
      };
    }

    if (outcome.reason === "pool-full") {
      return {
        accepted: false,
        message: "未使用话题已满 10 条，暂不触发新任务。"
      };
    }

    if (outcome.reason === "error") {
      return {
        accepted: false,
        message: `${taskLabel}执行失败：${outcome.detail ?? "未知错误"}`
      };
    }

    if (outcome.reason === "browse-missing-cookie") {
      return {
        accepted: false,
        message: "未配置 B 站 Cookie，请先在设置页完成登录。"
      };
    }

    if (outcome.reason === "browse-auth-expired") {
      return {
        accepted: false,
        message: "B 站登录已过期，请重新扫码登录。"
      };
    }

    if (outcome.reason === "browse-auth-error") {
      return {
        accepted: false,
        message: `B 站鉴权检查失败：${outcome.detail ?? "未知错误"}`
      };
    }

    if (outcome.reason === "added") {
      return {
        accepted: true,
        message: `${taskLabel}已执行，并新增了话题。`
      };
    }

    if (outcome.reason === "browse-noop") {
      return {
        accepted: true,
        message: "浏览任务已执行，本轮没有新增可聊内容。"
      };
    }

    return {
      accepted: true,
      message: `${taskLabel}已执行，但没有新增话题。`
    };
  }
}
