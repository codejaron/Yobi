import { generateObject, generateText } from "ai";
import { z } from "zod";
import type { AppConfig, HistoryMessage } from "@shared/types";
import type { ModelFactory } from "@main/core/model-factory";
import type { YobiMemory } from "@main/memory/setup";
import type { McpManager } from "@main/services/mcp-manager";

const RECALL_INTERVAL_MS = 3 * 60 * 60 * 1000;
const WANDER_INTERVAL_MS = 6 * 60 * 60 * 1000;

const recallSchema = z.object({
  topics: z.array(z.string().min(1).max(140)).max(2).default([])
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

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

export class BackgroundTaskService {
  private recallTimer: NodeJS.Timeout | null = null;
  private wanderTimer: NodeJS.Timeout | null = null;
  private recallRunning = false;
  private wanderRunning = false;

  constructor(
    private readonly modelFactory: ModelFactory,
    private readonly memory: YobiMemory,
    private readonly mcpManager: McpManager,
    private readonly getConfig: () => AppConfig,
    private readonly context: {
      resourceId: string;
      threadId: string;
    }
  ) {}

  start(): void {
    this.stop();
    this.recallTimer = setInterval(() => {
      void this.runRecallSafe();
    }, RECALL_INTERVAL_MS);

    this.wanderTimer = setInterval(() => {
      void this.runWanderSafe();
    }, WANDER_INTERVAL_MS);

    void this.runRecallSafe();
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

  private async runRecallSafe(): Promise<void> {
    if (this.recallRunning) {
      return;
    }

    this.recallRunning = true;
    try {
      await this.runRecall();
    } catch (error) {
      console.warn("[background] recall failed:", error);
    } finally {
      this.recallRunning = false;
    }
  }

  private async runWanderSafe(): Promise<void> {
    if (this.wanderRunning) {
      return;
    }

    this.wanderRunning = true;
    try {
      await this.runWander();
    } catch (error) {
      console.warn("[background] wander failed:", error);
    } finally {
      this.wanderRunning = false;
    }
  }

  private async runRecall(): Promise<void> {
    const config = this.getConfig();
    if (!config.proactive.enabled) {
      return;
    }

    const model = this.modelFactory.getChatModel();
    const workingMemory = await this.memory.getWorkingMemory(this.context);
    const history = await this.memory.listHistory({
      ...this.context,
      limit: 40,
      offset: 0
    });

    const result = await generateObject({
      model,
      providerOptions: this.buildProviderOptions(config),
      schema: recallSchema,
      system: [
        "你负责在后台整理主动聊天候选话题。",
        "只返回 topics 数组，最多 2 条。",
        "优先输出可延续、可追问的轻量话题，不要输出敏感或诊断类内容。",
        "如果没有值得主动提起的内容，返回空数组。"
      ].join("\n"),
      prompt: [
        `工作记忆:\n${workingMemory.markdown}`,
        `最近历史:\n${formatHistory(history)}`,
        "请给出 0-2 个一句话话题。"
      ].join("\n\n")
    } as any);

    const topics = recallSchema.parse(result.object ?? { topics: [] }).topics;
    for (const topic of topics) {
      await this.memory.addTopic({
        text: topic,
        source: "recall"
      });
    }
  }

  private async runWander(): Promise<void> {
    const config = this.getConfig();
    if (!config.proactive.enabled) {
      return;
    }

    const model = this.modelFactory.getChatModel();
    const workingMemory = await this.memory.getWorkingMemory(this.context);
    const history = await this.memory.listHistory({
      ...this.context,
      limit: 20,
      offset: 0
    });

    const plan = await generateObject({
      model,
      providerOptions: this.buildProviderOptions(config),
      schema: wanderPlanSchema,
      system: [
        "你在后台为用户挑选一个可搜索的新鲜话题方向。",
        "shouldSearch=false 表示当前不需要搜索。",
        "query 应该具体、可搜索、与用户画像相关。"
      ].join("\n"),
      prompt: [
        `工作记忆:\n${workingMemory.markdown}`,
        `最近历史:\n${formatHistory(history)}`,
        "返回 shouldSearch 和 query。"
      ].join("\n\n")
    } as any);

    const parsedPlan = wanderPlanSchema.parse(plan.object ?? {
      shouldSearch: false
    });
    const query = parsedPlan.query?.trim();

    if (!parsedPlan.shouldSearch || !query) {
      return;
    }

    const searchResult = await this.mcpManager.callServerTool("exa", "search", {
      query
    });
    const searchText = this.mcpManager.resultToText(searchResult).trim();
    if (!searchText) {
      return;
    }

    const digest = await generateText({
      model,
      providerOptions: this.buildProviderOptions(config),
      system: [
        "你负责把搜索结果浓缩成一个口语化、可直接开聊的话题。",
        "输出一句中文，不要编号，不要解释推理过程。",
        "如果结果无效或不适合聊天，返回空字符串。"
      ].join("\n"),
      prompt: [
        `搜索词: ${query}`,
        `搜索结果:\n${searchText.slice(0, 8000)}`,
        "请输出一句可用于主动聊天的话题。"
      ].join("\n\n"),
      maxOutputTokens: 120
    } as any);

    const topic = digest.text.replace(/\s+/g, " ").trim();
    if (!topic) {
      return;
    }

    await this.memory.addTopic({
      text: topic,
      source: "wander",
      expiresAt: hoursFromNow(48)
    });
  }

  private buildProviderOptions(config: AppConfig): Record<string, unknown> | undefined {
    const route = config.modelRouting.chat;
    const provider = config.providers.find((candidate) => candidate.id === route.providerId);
    if (!provider) {
      return undefined;
    }

    const usesResponsesApi =
      (provider.kind === "openai" || provider.kind === "custom-openai") &&
      provider.apiMode === "responses";

    if (!usesResponsesApi) {
      return undefined;
    }

    return {
      openai: {
        store: true
      }
    };
  }
}
