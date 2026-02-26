import { randomUUID } from "node:crypto";
import type { MemoryFact } from "@shared/types";
import { LlmRouter } from "./llm";
import { MemoryStore } from "@main/storage/memory-store";
import { HistoryStore } from "@main/storage/history";

export class MemoryManager {
  constructor(
    private readonly memoryStore: MemoryStore,
    private readonly historyStore: HistoryStore,
    private readonly llm: LlmRouter
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

  async extractAndMerge(): Promise<void> {
    const recentHistory = await this.historyStore.getRecent(120);
    if (recentHistory.length === 0) {
      return;
    }

    const existingFacts = this.memoryStore.listFacts();

    const merged = await this.llm.extractFacts({
      recentHistory,
      existingFacts
    });

    await this.memoryStore.replaceFacts(
      merged.map((fact) => ({
        id: existingFacts.find((existing) => existing.content === fact.content)?.id ?? randomUUID(),
        content: fact.content,
        confidence: fact.confidence,
        updatedAt: new Date().toISOString()
      }))
    );
  }

  async onConversationTurn(): Promise<void> {
    // 记忆提炼由 RecallService 周期驱动，这里保留扩展位。
  }
}
