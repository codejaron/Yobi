import type { LlmRouter } from "@main/core/llm";
import type { MemoryManager } from "@main/core/memory";
import type { HistoryStore } from "@main/storage/history";
import type { TopicPool } from "./topic-pool";

const DEFAULT_INTERVAL_MS = 3 * 60 * 60 * 1000;

export class RecallService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly llm: LlmRouter,
    private readonly memoryManager: MemoryManager,
    private readonly historyStore: HistoryStore,
    private readonly topicPool: TopicPool
  ) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => {
      void this.run();
    }, DEFAULT_INTERVAL_MS);
    void this.run();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  async run(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      await this.memoryManager.extractAndMerge();

      const facts = this.memoryManager.listFacts();
      const recentHistory = await this.historyStore.getRecent(40);
      if (facts.length === 0 && recentHistory.length === 0) {
        return;
      }

      const result = await this.llm.recall({
        facts,
        recentHistory,
        currentTime: new Date().toISOString()
      });

      for (const topic of result.topics) {
        await this.topicPool.add({
          text: topic,
          source: "recall",
          expiresAt: null
        });
      }

      await this.topicPool.cleanup();
    } catch (error) {
      console.warn("[recall] failed:", error);
    } finally {
      this.running = false;
    }
  }
}
