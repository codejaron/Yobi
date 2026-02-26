import type { LlmRouter } from "@main/core/llm";
import type { MemoryManager } from "@main/core/memory";
import type { TopicPool } from "./topic-pool";

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const WANDER_TOPIC_TTL_MS = 48 * 60 * 60 * 1000;

export class WanderService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly llm: LlmRouter,
    private readonly memoryManager: MemoryManager,
    private readonly topicPool: TopicPool,
    private readonly searchFn: (query: string) => Promise<string>
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
      const facts = this.memoryManager.listFacts();
      if (facts.length < 3) {
        return;
      }

      const plan = await this.llm.planWander({
        facts
      });

      if (!plan) {
        return;
      }

      const searchSnippets = await this.searchFn(plan.query);
      if (!searchSnippets.trim()) {
        return;
      }

      const topic = await this.llm.digestWander({
        query: plan.query,
        reason: plan.reason,
        searchSnippets
      });

      if (!topic) {
        return;
      }

      const dedupedTopics = await this.llm.filterNovelTopics({
        candidates: [topic],
        existingTopics: this.topicPool.listActive(80).map((item) => item.text)
      });
      if (dedupedTopics.length === 0) {
        return;
      }

      await this.topicPool.add({
        text: dedupedTopics[0],
        source: "wander",
        expiresAt: new Date(Date.now() + WANDER_TOPIC_TTL_MS).toISOString()
      });
    } catch (error) {
      console.warn("[wander] failed:", error);
    } finally {
      this.running = false;
    }
  }
}
