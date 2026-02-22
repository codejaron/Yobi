import { randomUUID } from "node:crypto";
import type { AppConfig, MemoryFact } from "@shared/types";
import { LlmRouter } from "./llm";
import { MemoryStore } from "@main/storage/memory-store";
import { HistoryStore } from "@main/storage/history";

export class MemoryManager {
  constructor(
    private readonly memoryStore: MemoryStore,
    private readonly historyStore: HistoryStore,
    private readonly llm: LlmRouter,
    private readonly getConfig: () => AppConfig
  ) {}

  listFacts(): MemoryFact[] {
    return this.memoryStore.listFacts();
  }

  async createOrUpdateFact(input: {
    id?: string;
    content: string;
    confidence: number;
  }): Promise<MemoryFact> {
    return this.memoryStore.upsertFact({
      id: input.id,
      content: input.content,
      confidence: input.confidence
    });
  }

  async deleteFact(id: string): Promise<void> {
    await this.memoryStore.removeFact(id);
  }

  async onConversationTurn(): Promise<void> {
    const turnsSinceSummary = await this.memoryStore.incrementTurns();
    const summarizeEveryTurns = this.getConfig().memory.summarizeEveryTurns;

    if (turnsSinceSummary < summarizeEveryTurns) {
      return;
    }

    const recentHistory = await this.historyStore.getRecent(120);
    const existingFacts = this.memoryStore.listFacts();

    const extracted = await this.llm.extractFacts({
      recentHistory,
      existingFacts
    });

    const merged = this.mergeFacts(existingFacts, extracted);
    await this.memoryStore.replaceFacts(merged);
    await this.memoryStore.markSummary(0);
  }

  private mergeFacts(
    existing: MemoryFact[],
    extracted: Array<{ content: string; confidence: number }>
  ): MemoryFact[] {
    const index = new Map<string, MemoryFact>();

    for (const fact of existing) {
      index.set(fact.content.trim().toLowerCase(), fact);
    }

    for (const fact of extracted) {
      const key = fact.content.trim().toLowerCase();
      const previous = index.get(key);
      const now = new Date().toISOString();

      if (!previous) {
        index.set(key, {
          id: randomUUID(),
          content: fact.content.trim(),
          confidence: fact.confidence,
          updatedAt: now
        });
        continue;
      }

      index.set(key, {
        ...previous,
        confidence: Math.max(previous.confidence, fact.confidence),
        updatedAt: now
      });
    }

    return Array.from(index.values())
      .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1))
      .slice(0, 80);
  }
}
