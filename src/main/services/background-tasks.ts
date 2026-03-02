import { generateObject, generateText } from "ai";
import { z } from "zod";
import { readJsonFile, writeJsonFile } from "@main/storage/fs";
import type { AppConfig, HistoryMessage, TopicPoolItem } from "@shared/types";
import type { ModelFactory } from "@main/core/model-factory";
import { resolveOpenAIStoreOption } from "@main/core/provider-utils";
import type { YobiMemory } from "@main/memory/setup";
import type { McpManager } from "@main/services/mcp-manager";

const RECALL_INTERVAL_MS = 3 * 60 * 60 * 1000;
const WANDER_INTERVAL_MS = 6 * 60 * 60 * 1000;
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
  | "search-skipped"
  | "empty-search-result"
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

const wanderPlanSchema = z.object({
  shouldSearch: z.boolean().default(true),
  query: z.string().min(2).max(120).optional()
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

function intervalForTask(task: BackgroundTaskName): number {
  return task === "recall" ? RECALL_INTERVAL_MS : WANDER_INTERVAL_MS;
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
    private readonly mcpManager: McpManager,
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
    return this.toManualTriggerResult("闲逛", outcome);
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

    const result = await generateObject({
      model,
      providerOptions: resolveOpenAIStoreOption(config),
      schema: recallSchema,
      system: [
        "你负责在后台整理主动聊天候选话题。",
        "只返回 topics 数组，最多 2 条，每条都包含 text，可选 expiresInHours。",
        "在产出前必须回顾已有话题池，避免和任何已有话题重复（含语义重复）。",
        "优先输出可延续、可追问的轻量话题，不要输出敏感或诊断类内容。",
        "如果没有值得主动提起的内容，返回空数组。"
      ].join("\n"),
      prompt: [
        `工作记忆:\n${workingMemory.markdown}`,
        `最近历史:\n${formatHistory(history)}`,
        `已有话题池（含已使用）:\n${formatTopicPool(topicPool)}`,
        "请给出 0-2 个一句话话题。"
      ].join("\n\n")
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
      limit: 20,
      offset: 0
    });
    const topicPool = await this.memory.listTopicPool(200);

    const plan = await generateObject({
      model,
      providerOptions: resolveOpenAIStoreOption(config),
      schema: wanderPlanSchema,
      system: [
        "你在后台为用户挑选一个可搜索的新鲜话题方向。",
        "shouldSearch=false 表示当前不需要搜索。",
        "产出前先回顾已有话题池，避免计划与已有话题重复。",
        "query 应该具体、可搜索、与用户画像相关。"
      ].join("\n"),
      prompt: [
        `工作记忆:\n${workingMemory.markdown}`,
        `最近历史:\n${formatHistory(history)}`,
        `已有话题池（含已使用）:\n${formatTopicPool(topicPool)}`,
        "返回 shouldSearch 和 query。"
      ].join("\n\n")
    });

    const parsedPlan = wanderPlanSchema.parse(plan.object ?? {
      shouldSearch: false
    });
    const query = parsedPlan.query?.trim();

    if (!parsedPlan.shouldSearch || !query) {
      return {
        ran: true,
        changed: false,
        reason: "search-skipped"
      };
    }

    const searchResult = await this.mcpManager.callServerTool("exa", "search", {
      query
    });
    const searchText = this.mcpManager.resultToText(searchResult).trim();
    if (!searchText) {
      return {
        ran: true,
        changed: false,
        reason: "empty-search-result"
      };
    }

    const digest = await generateText({
      model,
      providerOptions: resolveOpenAIStoreOption(config),
      system: [
        "你负责把搜索结果浓缩成一个口语化、可直接开聊的话题。",
        "输出前必须回顾已有话题池，确保不重复。",
        "输出一句中文，不要编号，不要解释推理过程。",
        "如果结果无效或不适合聊天，返回空字符串。"
      ].join("\n"),
      prompt: [
        `搜索词: ${query}`,
        `搜索结果:\n${searchText.slice(0, 8000)}`,
        `已有话题池（含已使用）:\n${formatTopicPool(topicPool)}`,
        "请输出一句可用于主动聊天的话题。"
      ].join("\n\n"),
      maxOutputTokens: 120
    });

    const topic = digest.text.replace(/\s+/g, " ").trim();
    if (!topic) {
      return {
        ran: true,
        changed: false,
        reason: "no-new-topic"
      };
    }

    const inserted = await this.memory.addTopic({
      text: topic,
      source: "wander",
      expiresAt: hoursFromNow(48)
    });

    return {
      ran: true,
      changed: inserted,
      reason: inserted ? "added" : "no-new-topic"
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
    return elapsed >= intervalForTask(task);
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

  private toManualTriggerResult(taskLabel: "回想" | "闲逛", outcome: TaskRunOutcome): BackgroundTaskTriggerResult {
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

    if (outcome.reason === "search-skipped") {
      return {
        accepted: true,
        message: "闲逛已执行，AI 判断当前无需发起搜索。"
      };
    }

    if (outcome.reason === "empty-search-result") {
      return {
        accepted: true,
        message: "闲逛已执行，但搜索结果为空。"
      };
    }

    if (outcome.reason === "added") {
      return {
        accepted: true,
        message: `${taskLabel}已执行，并新增了话题。`
      };
    }

    return {
      accepted: true,
      message: `${taskLabel}已执行，但没有新增话题。`
    };
  }
}
