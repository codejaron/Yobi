import { randomUUID } from "node:crypto";
import {
  DEFAULT_MEMORY,
  memoryDocumentSchema,
  type MemoryDocument,
  type MemoryFact
} from "@shared/types";
import { CompanionPaths } from "./paths";
import { fileExists, readJsonFile, writeJsonFile } from "./fs";

export class MemoryStore {
  private cached: MemoryDocument = DEFAULT_MEMORY;

  constructor(private readonly paths: CompanionPaths) {}

  async init(): Promise<void> {
    const exists = await fileExists(this.paths.memoryPath);
    if (!exists) {
      this.cached = DEFAULT_MEMORY;
      await writeJsonFile(this.paths.memoryPath, this.cached);
      return;
    }

    const raw = await readJsonFile<MemoryDocument>(this.paths.memoryPath, DEFAULT_MEMORY);
    this.cached = memoryDocumentSchema.parse(raw);
    await writeJsonFile(this.paths.memoryPath, this.cached);
  }

  getDocument(): MemoryDocument {
    return this.cached;
  }

  listFacts(): MemoryFact[] {
    return [...this.cached.facts].sort((a, b) =>
      a.updatedAt > b.updatedAt ? -1 : a.updatedAt < b.updatedAt ? 1 : 0
    );
  }

  async upsertFact(input: Omit<MemoryFact, "id" | "updatedAt"> & { id?: string }): Promise<MemoryFact> {
    const nextFact: MemoryFact = {
      id: input.id ?? randomUUID(),
      content: input.content,
      confidence: input.confidence,
      updatedAt: new Date().toISOString()
    };

    const nextFacts = this.cached.facts.filter((fact) => fact.id !== nextFact.id);
    nextFacts.push(nextFact);

    this.cached = {
      ...this.cached,
      facts: nextFacts
    };

    await this.persist();
    return nextFact;
  }

  async removeFact(id: string): Promise<void> {
    this.cached = {
      ...this.cached,
      facts: this.cached.facts.filter((fact) => fact.id !== id)
    };

    await this.persist();
  }

  async clearFacts(): Promise<void> {
    this.cached = {
      ...this.cached,
      facts: []
    };

    await this.persist();
  }

  async replaceFacts(facts: MemoryFact[]): Promise<void> {
    this.cached = {
      ...this.cached,
      facts
    };
    await this.persist();
  }

  private async persist(): Promise<void> {
    this.cached = memoryDocumentSchema.parse(this.cached);
    await writeJsonFile(this.paths.memoryPath, this.cached);
  }
}
