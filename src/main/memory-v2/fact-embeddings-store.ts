import type { Fact } from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import { readJsonFile, writeJsonFileAtomic } from "@main/storage/fs";

export interface FactEmbeddingRecord {
  fact_id: string;
  model_id: string;
  vector: number[];
  updated_at: string;
}

export interface SemanticFactMatch {
  fact: Fact;
  semanticScore: number;
}

const MAX_EMBEDDED_ACTIVE_FACTS = 2000;

export class FactEmbeddingStore {
  private loaded = false;
  private dirty = false;
  private records = new Map<string, FactEmbeddingRecord>();

  constructor(private readonly paths: CompanionPaths) {}

  async init(): Promise<void> {
    if (this.loaded) {
      return;
    }

    const rows = await readJsonFile<FactEmbeddingRecord[]>(this.paths.factEmbeddingsPath, []);
    for (const row of rows) {
      const normalized = normalizeRecord(row);
      if (normalized) {
        this.records.set(normalized.fact_id, normalized);
      }
    }
    this.loaded = true;
  }

  get(factId: string): FactEmbeddingRecord | null {
    const row = this.records.get(factId);
    return row ? { ...row, vector: [...row.vector] } : null;
  }

  async upsert(input: FactEmbeddingRecord[]): Promise<void> {
    await this.init();
    let changed = false;
    for (const row of input) {
      const normalized = normalizeRecord(row);
      if (!normalized) {
        continue;
      }
      const existing = this.records.get(normalized.fact_id);
      if (existing && sameEmbedding(existing, normalized)) {
        continue;
      }
      this.records.set(normalized.fact_id, normalized);
      changed = true;
    }
    if (changed) {
      this.dirty = true;
    }
  }

  async flushIfDirty(): Promise<void> {
    await this.init();
    if (!this.dirty) {
      return;
    }
    await this.forceFlush();
  }

  async forceFlush(): Promise<void> {
    await this.init();
    await writeJsonFileAtomic(this.paths.factEmbeddingsPath, [...this.records.values()].sort((a, b) => a.fact_id.localeCompare(b.fact_id)));
    this.dirty = false;
  }

  async findPendingFacts(facts: Fact[], modelId: string, limit = 10): Promise<Fact[]> {
    await this.init();
    const activeFacts = facts
      .slice()
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .slice(0, MAX_EMBEDDED_ACTIVE_FACTS);

    return activeFacts.filter((fact) => {
      const row = this.records.get(fact.id);
      return !row || row.model_id !== modelId || row.vector.length === 0;
    }).slice(0, Math.max(1, limit));
  }

  async search(
    facts: Fact[],
    modelId: string,
    queryVector: number[],
    similarityThreshold: number,
    limit = 20
  ): Promise<SemanticFactMatch[]> {
    await this.init();
    if (queryVector.length === 0 || facts.length === 0) {
      return [];
    }

    const scored: SemanticFactMatch[] = [];
    for (const fact of facts) {
      const row = this.records.get(fact.id);
      if (!row || row.model_id !== modelId || row.vector.length === 0) {
        continue;
      }
      const semanticScore = cosineSimilarity(queryVector, row.vector);
      if (semanticScore < similarityThreshold) {
        continue;
      }
      scored.push({
        fact,
        semanticScore
      });
    }

    return scored.sort((a, b) => b.semanticScore - a.semanticScore).slice(0, Math.max(1, limit));
  }
}

function normalizeRecord(raw: FactEmbeddingRecord): FactEmbeddingRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const factId = typeof raw.fact_id === "string" ? raw.fact_id.trim() : "";
  const modelId = typeof raw.model_id === "string" ? raw.model_id.trim() : "";
  const vector = Array.isArray(raw.vector)
    ? raw.vector.map((value) => (typeof value === "number" && Number.isFinite(value) ? value : 0))
    : [];
  if (!factId || !modelId || vector.length === 0) {
    return null;
  }

  return {
    fact_id: factId,
    model_id: modelId,
    vector,
    updated_at:
      typeof raw.updated_at === "string" && Number.isFinite(new Date(raw.updated_at).getTime())
        ? new Date(raw.updated_at).toISOString()
        : new Date().toISOString()
  };
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm <= 0 || rightNorm <= 0) {
    return 0;
  }

  return dot / Math.sqrt(leftNorm * rightNorm);
}

function sameEmbedding(left: FactEmbeddingRecord, right: FactEmbeddingRecord): boolean {
  if (left.model_id !== right.model_id || left.vector.length !== right.vector.length) {
    return false;
  }
  return left.vector.every((value, index) => value === right.vector[index]);
}
