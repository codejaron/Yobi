import { randomUUID } from "node:crypto";
import type { Fact, FactCategory, FactTtlClass } from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import { readJsonFile, writeJsonFileAtomic } from "@main/storage/fs";

export interface FactOperationInput {
  action: "add" | "update" | "supersede";
  fact: {
    entity: string;
    key: string;
    value: string;
    category: FactCategory;
    confidence: number;
    ttl_class: FactTtlClass;
    source?: string;
    source_range?: string;
  };
}

export class FactsStore {
  private loaded = false;
  private activeFacts: Fact[] = [];
  private archiveFacts: Fact[] = [];

  constructor(private readonly paths: CompanionPaths) {}

  async init(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.activeFacts = await readJsonFile<Fact[]>(this.paths.factsPath, []);
    this.archiveFacts = await readJsonFile<Fact[]>(this.paths.factsArchivePath, []);
    this.activeFacts = this.activeFacts.map((fact) => normalizeFact(fact)).filter((fact): fact is Fact => fact !== null);
    this.archiveFacts = this.archiveFacts
      .map((fact) => normalizeFact(fact))
      .filter((fact): fact is Fact => fact !== null);
    this.loaded = true;
  }

  listActive(): Fact[] {
    return this.activeFacts.map((fact) => ({ ...fact }));
  }

  listArchive(): Fact[] {
    return this.archiveFacts.map((fact) => ({ ...fact }));
  }

  listAll(): Fact[] {
    return [...this.listActive(), ...this.listArchive()];
  }

  async applyOperations(operations: FactOperationInput[], source = "fact-extraction"): Promise<Fact[]> {
    await this.init();
    if (operations.length === 0) {
      return [];
    }

    const now = new Date().toISOString();
    const changed: Fact[] = [];
    for (const operation of operations) {
      const normalized = normalizeOperation(operation);
      if (!normalized) {
        continue;
      }

      if (normalized.action === "add") {
        const dedupe = this.activeFacts.find(
          (item) =>
            item.entity === normalized.fact.entity &&
            item.key === normalized.fact.key &&
            item.value === normalized.fact.value &&
            item.superseded_by === null
        );
        if (dedupe) {
          dedupe.updated_at = now;
          dedupe.last_accessed_at = now;
          dedupe.confidence = Math.max(dedupe.confidence, normalized.fact.confidence);
          changed.push({ ...dedupe });
          continue;
        }

        const fact = createFact(normalized.fact, source, now);
        this.activeFacts.push(fact);
        changed.push({ ...fact });
        continue;
      }

      const current = this.findLatest(normalized.fact.entity, normalized.fact.key);
      if (!current) {
        const fact = createFact(normalized.fact, source, now);
        this.activeFacts.push(fact);
        changed.push({ ...fact });
        continue;
      }

      if (normalized.action === "update") {
        current.value = normalized.fact.value;
        current.category = normalized.fact.category;
        current.confidence = normalized.fact.confidence;
        current.ttl_class = normalized.fact.ttl_class;
        current.updated_at = now;
        current.last_accessed_at = now;
        current.source = normalized.fact.source || source;
        current.source_range = normalized.fact.source_range;
        changed.push({ ...current });
        continue;
      }

      const replacement = createFact(normalized.fact, source, now);
      current.superseded_by = replacement.id;
      current.updated_at = now;
      current.last_accessed_at = now;
      this.archiveFacts.push({ ...current });
      this.activeFacts = this.activeFacts.filter((item) => item.id !== current.id);
      this.activeFacts.push(replacement);
      changed.push({ ...replacement });
    }

    await this.persist();
    return changed;
  }

  async touch(ids: string[]): Promise<void> {
    await this.init();
    if (ids.length === 0) {
      return;
    }
    const now = new Date().toISOString();
    let changed = false;
    for (const fact of this.activeFacts) {
      if (!ids.includes(fact.id)) {
        continue;
      }
      fact.last_accessed_at = now;
      fact.updated_at = now;
      changed = true;
    }
    if (changed) {
      await this.persist();
    }
  }

  async cleanupExpired(nowIso = new Date().toISOString()): Promise<{ moved: number }> {
    await this.init();
    const now = new Date(nowIso).getTime();
    const remaining: Fact[] = [];
    let moved = 0;

    for (const fact of this.activeFacts) {
      const shouldExpire = isFactExpired(fact, now);
      if (!shouldExpire) {
        remaining.push(fact);
        continue;
      }
      this.archiveFacts.push({ ...fact });
      moved += 1;
    }

    if (moved > 0) {
      this.activeFacts = remaining;
      await this.persist();
    }

    return {
      moved
    };
  }

  private findLatest(entity: string, key: string): Fact | null {
    const matches = this.activeFacts
      .filter((fact) => fact.entity === entity && fact.key === key && fact.superseded_by === null)
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    return matches[0] ?? null;
  }

  private async persist(): Promise<void> {
    await writeJsonFileAtomic(this.paths.factsPath, this.activeFacts);
    await writeJsonFileAtomic(this.paths.factsArchivePath, this.archiveFacts);
  }
}

function normalizeOperation(input: FactOperationInput): FactOperationInput | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  if (input.action !== "add" && input.action !== "update" && input.action !== "supersede") {
    return null;
  }
  const fact = input.fact;
  if (!fact || typeof fact !== "object") {
    return null;
  }
  const entity = typeof fact.entity === "string" ? fact.entity.trim() : "";
  const key = typeof fact.key === "string" ? fact.key.trim() : "";
  const value = typeof fact.value === "string" ? fact.value.trim() : "";
  if (!entity || !key || !value) {
    return null;
  }
  return {
    action: input.action,
    fact: {
      entity,
      key,
      value,
      category: normalizeCategory(fact.category),
      confidence: clampConfidence(fact.confidence),
      ttl_class: normalizeTtlClass(fact.ttl_class),
      source: typeof fact.source === "string" ? fact.source : undefined,
      source_range: typeof fact.source_range === "string" ? fact.source_range : undefined
    }
  };
}

function createFact(
  fact: FactOperationInput["fact"],
  fallbackSource: string,
  now: string
): Fact {
  return {
    id: randomUUID(),
    entity: fact.entity,
    key: fact.key,
    value: fact.value,
    category: fact.category,
    confidence: clampConfidence(fact.confidence),
    source: fact.source || fallbackSource,
    created_at: now,
    updated_at: now,
    ttl_class: fact.ttl_class,
    last_accessed_at: now,
    superseded_by: null,
    source_range: fact.source_range
  };
}

function normalizeFact(raw: Fact): Fact | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const entity = typeof raw.entity === "string" ? raw.entity.trim() : "";
  const key = typeof raw.key === "string" ? raw.key.trim() : "";
  const value = typeof raw.value === "string" ? raw.value.trim() : "";
  if (!entity || !key || !value) {
    return null;
  }
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : randomUUID(),
    entity,
    key,
    value,
    category: normalizeCategory(raw.category),
    confidence: clampConfidence(raw.confidence),
    source: typeof raw.source === "string" ? raw.source : "unknown",
    created_at:
      typeof raw.created_at === "string" && Number.isFinite(new Date(raw.created_at).getTime())
        ? new Date(raw.created_at).toISOString()
        : new Date().toISOString(),
    updated_at:
      typeof raw.updated_at === "string" && Number.isFinite(new Date(raw.updated_at).getTime())
        ? new Date(raw.updated_at).toISOString()
        : new Date().toISOString(),
    ttl_class: normalizeTtlClass(raw.ttl_class),
    last_accessed_at:
      typeof raw.last_accessed_at === "string" && Number.isFinite(new Date(raw.last_accessed_at).getTime())
        ? new Date(raw.last_accessed_at).toISOString()
        : new Date().toISOString(),
    superseded_by: typeof raw.superseded_by === "string" ? raw.superseded_by : null,
    source_range: typeof raw.source_range === "string" ? raw.source_range : undefined
  };
}

function normalizeCategory(value: unknown): FactCategory {
  if (
    value === "identity" ||
    value === "preference" ||
    value === "event" ||
    value === "goal" ||
    value === "relationship" ||
    value === "emotion_pattern"
  ) {
    return value;
  }
  return "event";
}

function normalizeTtlClass(value: unknown): FactTtlClass {
  if (value === "permanent" || value === "stable" || value === "active" || value === "session") {
    return value;
  }
  return "stable";
}

function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0.6;
  }
  return Math.max(0, Math.min(1, value));
}

function isFactExpired(fact: Fact, nowMs: number): boolean {
  if (fact.ttl_class === "permanent") {
    return false;
  }

  const lastAccessedMs = new Date(fact.last_accessed_at).getTime();
  const ageMs = Number.isFinite(lastAccessedMs) ? nowMs - lastAccessedMs : 0;
  const day = 24 * 60 * 60 * 1000;

  if (fact.ttl_class === "session") {
    return ageMs > day;
  }
  if (fact.ttl_class === "active") {
    return ageMs > 14 * day;
  }
  return ageMs > 90 * day;
}
