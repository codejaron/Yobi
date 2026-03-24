import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Fact, FactCategory, FactTtlClass } from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import { ChineseTokenizerService } from "./chinese-tokenizer";

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

export interface LexicalFactMatch {
  fact: Fact;
  bm25Raw: number;
}

interface FactRow {
  id: string;
  entity: string;
  key: string;
  value: string;
  category: string;
  confidence: number;
  source: string;
  created_at: string;
  updated_at: string;
  ttl_class: string;
  last_accessed_at: string;
  superseded_by: string | null;
  source_range: string | null;
}

const BASE_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  category TEXT NOT NULL,
  confidence REAL NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ttl_class TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  superseded_by TEXT,
  source_range TEXT
);
CREATE TABLE IF NOT EXISTS facts_archive (
  id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  category TEXT NOT NULL,
  confidence REAL NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ttl_class TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  superseded_by TEXT,
  source_range TEXT
);
CREATE INDEX IF NOT EXISTS idx_facts_entity_key ON facts(entity, key);
CREATE INDEX IF NOT EXISTS idx_facts_source_entity ON facts(source, entity);
CREATE INDEX IF NOT EXISTS idx_facts_archive_source_entity ON facts_archive(source, entity);
`;

const FTS_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
  fact_id UNINDEXED,
  content,
  tokenize = "unicode61 remove_diacritics 0 tokenchars '.+-/#'"
);
`;

export class FactsStore {
  private loaded = false;
  private db: DatabaseSync | null = null;
  private readonly tokenizer = new ChineseTokenizerService();
  private lexicalAvailable = false;
  private lexicalMessage = "fts-uninitialized";

  constructor(private readonly paths: CompanionPaths) {}

  async init(): Promise<void> {
    if (this.loaded) {
      return;
    }

    this.db = new DatabaseSync(this.paths.factsDbPath);
    this.db.exec(BASE_SCHEMA_SQL);

    try {
      await this.tokenizer.init();
      this.db.exec(FTS_SCHEMA_SQL);
      this.lexicalAvailable = true;
      this.lexicalMessage = "fts-ready";
    } catch (error) {
      this.lexicalAvailable = false;
      this.lexicalMessage = error instanceof Error ? error.message : "fts-init-failed";
    }

    this.loaded = true;
  }

  async close(): Promise<void> {
    if (!this.db) {
      this.loaded = false;
      this.lexicalAvailable = false;
      this.lexicalMessage = "fts-uninitialized";
      return;
    }

    try {
      this.db.close();
    } finally {
      this.db = null;
      this.loaded = false;
      this.lexicalAvailable = false;
      this.lexicalMessage = "fts-uninitialized";
    }
  }

  listActive(): Fact[] {
    const db = this.requireDb();
    return db
      .prepare(`SELECT * FROM facts ORDER BY updated_at DESC`)
      .all()
      .map((row) => normalizeFact(row as unknown as FactRow))
      .filter((fact): fact is Fact => fact !== null);
  }

  listArchive(): Fact[] {
    const db = this.requireDb();
    return db
      .prepare(`SELECT * FROM facts_archive ORDER BY updated_at DESC`)
      .all()
      .map((row) => normalizeFact(row as unknown as FactRow))
      .filter((fact): fact is Fact => fact !== null);
  }

  listAll(): Fact[] {
    return [...this.listActive(), ...this.listArchive()];
  }

  async applyOperations(operations: FactOperationInput[], source = "manual"): Promise<Fact[]> {
    await this.init();
    if (operations.length === 0) {
      return [];
    }

    const db = this.requireDb();
    const changed: Fact[] = [];

    db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      for (const operation of operations) {
        const normalized = normalizeOperation(operation);
        if (!normalized) {
          continue;
        }

        const now = new Date().toISOString();
        if (normalized.action === "add") {
          const dedupe = this.findExactActive(normalized.fact.entity, normalized.fact.key, normalized.fact.value);
          if (dedupe) {
            const updated = {
              ...dedupe,
              updated_at: now,
              last_accessed_at: now,
              confidence: Math.max(dedupe.confidence, normalized.fact.confidence)
            };
            await this.saveActiveFact(updated);
            changed.push({ ...updated });
            continue;
          }

          const fact = createFact(normalized.fact, source, now);
          await this.saveActiveFact(fact);
          changed.push({ ...fact });
          continue;
        }

        const current = this.findLatest(normalized.fact.entity, normalized.fact.key);
        if (!current) {
          const fact = createFact(normalized.fact, source, now);
          await this.saveActiveFact(fact);
          changed.push({ ...fact });
          continue;
        }

        if (normalized.action === "update") {
          const updated: Fact = {
            ...current,
            value: normalized.fact.value,
            category: normalized.fact.category,
            confidence: normalized.fact.confidence,
            ttl_class: normalized.fact.ttl_class,
            updated_at: now,
            last_accessed_at: now,
            source: normalized.fact.source || source,
            source_range: normalized.fact.source_range
          };
          await this.saveActiveFact(updated);
          changed.push({ ...updated });
          continue;
        }

        const replacement = createFact(normalized.fact, source, now);
        const archivedCurrent: Fact = {
          ...current,
          superseded_by: replacement.id,
          updated_at: now,
          last_accessed_at: now
        };
        this.archiveFact(archivedCurrent);
        this.deleteActiveFact(current.id);
        await this.saveActiveFact(replacement);
        changed.push({ ...replacement });
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return changed;
  }

  async replaceBySource(input: {
    source: string;
    entity?: string;
    facts: Array<FactOperationInput["fact"]>;
  }): Promise<Fact[]> {
    await this.init();
    const db = this.requireDb();
    const source = input.source.trim();
    const entity = input.entity?.trim();
    const now = new Date().toISOString();
    const created: Fact[] = [];

    db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const existing = this.findBySource(source, entity);
      for (const fact of existing) {
        this.deleteActiveFact(fact.id);
      }

      for (const next of input.facts) {
        const normalized = normalizeOperation({ action: "add", fact: next });
        if (!normalized) {
          continue;
        }
        const fact = createFact(normalized.fact, source, now);
        await this.saveActiveFact(fact);
        created.push({ ...fact });
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return created;
  }

  async removeBySource(input: { source: string; entity?: string }): Promise<number> {
    await this.init();
    const db = this.requireDb();
    const existing = this.findBySource(input.source.trim(), input.entity?.trim());
    if (existing.length === 0) {
      return 0;
    }

    db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      for (const fact of existing) {
        this.deleteActiveFact(fact.id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return existing.length;
  }

  async touch(ids: string[]): Promise<void> {
    await this.init();
    if (ids.length === 0) {
      return;
    }
    const db = this.requireDb();
    const now = new Date().toISOString();
    const statement = db.prepare(`UPDATE facts SET last_accessed_at = ? WHERE id = ?`);
    for (const id of ids) {
      statement.run(now, id);
    }
  }

  async cleanupExpired(nowIso = new Date().toISOString(), softCap?: number): Promise<{ moved: number }> {
    await this.init();
    const db = this.requireDb();
    const now = new Date(nowIso).getTime();
    let moved = 0;

    db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const activeFacts = this.listActive();
      const expired = activeFacts.filter((fact) => isFactExpired(fact, now));
      for (const fact of expired) {
        this.archiveFact(fact);
        this.deleteActiveFact(fact.id);
        moved += 1;
      }

      const normalizedCap =
        typeof softCap === "number" && Number.isFinite(softCap) ? Math.max(1, Math.floor(softCap)) : null;
      if (normalizedCap) {
        const remaining = this.listActive();
        if (remaining.length > normalizedCap) {
          const overflow = remaining
            .slice()
            .sort((left, right) => new Date(left.last_accessed_at).getTime() - new Date(right.last_accessed_at).getTime())
            .slice(0, remaining.length - normalizedCap);
          for (const fact of overflow) {
            this.archiveFact(fact);
            this.deleteActiveFact(fact.id);
            moved += 1;
          }
        }
      }

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return { moved };
  }

  async clearAll(): Promise<void> {
    await this.init();
    const db = this.requireDb();
    db.exec(`DELETE FROM facts; DELETE FROM facts_archive;`);
    if (this.lexicalAvailable) {
      db.exec(`DELETE FROM facts_fts;`);
    }
  }

  async searchLexical(queryTexts: string[], limit = 20): Promise<LexicalFactMatch[]> {
    await this.init();
    if (!this.lexicalAvailable) {
      return [];
    }

    const tokens = await this.tokenizeQueryTexts(queryTexts);
    const matchQuery = this.tokenizer.buildMatchQuery(tokens);
    if (!matchQuery) {
      return [];
    }

    const db = this.requireDb();
    try {
      const rows = db
        .prepare(`
          SELECT
            facts.id,
            facts.entity,
            facts.key,
            facts.value,
            facts.category,
            facts.confidence,
            facts.source,
            facts.created_at,
            facts.updated_at,
            facts.ttl_class,
            facts.last_accessed_at,
            facts.superseded_by,
            facts.source_range,
            bm25(facts_fts) AS bm25_score
          FROM facts_fts
          JOIN facts ON facts_fts.fact_id = facts.id
          WHERE facts_fts MATCH ?
          ORDER BY bm25_score
          LIMIT ?
        `)
        .all(matchQuery, Math.max(1, limit));

      return rows
        .map((row) => {
          const fact = normalizeFact(row as unknown as FactRow);
          if (!fact) {
            return null;
          }
          const rawScore = typeof (row as { bm25_score?: unknown }).bm25_score === "number"
            ? Math.abs((row as { bm25_score: number }).bm25_score)
            : 0;
          return {
            fact,
            bm25Raw: rawScore
          };
        })
        .filter((row): row is LexicalFactMatch => row !== null);
    } catch {
      return [];
    }
  }

  getLexicalStatus(): { available: boolean; message: string } {
    return {
      available: this.lexicalAvailable,
      message: this.lexicalMessage
    };
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("facts-db-not-initialized");
    }
    return this.db;
  }

  private findExactActive(entity: string, key: string, value: string): Fact | null {
    const row = this.requireDb()
      .prepare(`SELECT * FROM facts WHERE entity = ? AND key = ? AND value = ? LIMIT 1`)
      .get(entity, key, value) as unknown as FactRow | undefined;
    return normalizeFact(row ?? null);
  }

  private findLatest(entity: string, key: string): Fact | null {
    const row = this.requireDb()
      .prepare(`SELECT * FROM facts WHERE entity = ? AND key = ? ORDER BY updated_at DESC LIMIT 1`)
      .get(entity, key) as unknown as FactRow | undefined;
    return normalizeFact(row ?? null);
  }

  private findBySource(source: string, entity?: string): Fact[] {
    const db = this.requireDb();
    const rows = entity
      ? db.prepare(`SELECT * FROM facts WHERE source = ? AND entity = ?`).all(source, entity)
      : db.prepare(`SELECT * FROM facts WHERE source = ?`).all(source);
    return rows.map((row) => normalizeFact(row as unknown as FactRow)).filter((fact): fact is Fact => fact !== null);
  }

  private async upsertFts(fact: Fact): Promise<void> {
    if (!this.lexicalAvailable) {
      return;
    }
    const db = this.requireDb();
    const searchableText = buildSearchableText(fact);
    const tokens = await this.tokenizer.tokenizeForIndex(searchableText);
    db.prepare(`DELETE FROM facts_fts WHERE fact_id = ?`).run(fact.id);
    db.prepare(`INSERT INTO facts_fts (fact_id, content) VALUES (?, ?)`).run(fact.id, tokens.join(" "));
  }

  private async saveActiveFact(fact: Fact): Promise<void> {
    const db = this.requireDb();
    db.prepare(`
      INSERT INTO facts (
        id, entity, key, value, category, confidence, source,
        created_at, updated_at, ttl_class, last_accessed_at, superseded_by, source_range
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        entity = excluded.entity,
        key = excluded.key,
        value = excluded.value,
        category = excluded.category,
        confidence = excluded.confidence,
        source = excluded.source,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        ttl_class = excluded.ttl_class,
        last_accessed_at = excluded.last_accessed_at,
        superseded_by = excluded.superseded_by,
        source_range = excluded.source_range
    `).run(
      fact.id,
      fact.entity,
      fact.key,
      fact.value,
      fact.category,
      fact.confidence,
      fact.source,
      fact.created_at,
      fact.updated_at,
      fact.ttl_class,
      fact.last_accessed_at,
      fact.superseded_by,
      fact.source_range ?? null
    );
    await this.upsertFts(fact);
  }

  private archiveFact(fact: Fact): void {
    this.requireDb().prepare(`
      INSERT INTO facts_archive (
        id, entity, key, value, category, confidence, source,
        created_at, updated_at, ttl_class, last_accessed_at, superseded_by, source_range
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        entity = excluded.entity,
        key = excluded.key,
        value = excluded.value,
        category = excluded.category,
        confidence = excluded.confidence,
        source = excluded.source,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        ttl_class = excluded.ttl_class,
        last_accessed_at = excluded.last_accessed_at,
        superseded_by = excluded.superseded_by,
        source_range = excluded.source_range
    `).run(
      fact.id,
      fact.entity,
      fact.key,
      fact.value,
      fact.category,
      fact.confidence,
      fact.source,
      fact.created_at,
      fact.updated_at,
      fact.ttl_class,
      fact.last_accessed_at,
      fact.superseded_by,
      fact.source_range ?? null
    );
  }

  private deleteActiveFact(id: string): void {
    const db = this.requireDb();
    db.prepare(`DELETE FROM facts WHERE id = ?`).run(id);
    if (this.lexicalAvailable) {
      db.prepare(`DELETE FROM facts_fts WHERE fact_id = ?`).run(id);
    }
  }

  private async tokenizeQueryTexts(texts: string[]): Promise<string[]> {
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const text of texts.slice(-3)) {
      for (const token of await this.tokenizer.tokenizeForQuery(text)) {
        if (seen.has(token)) {
          continue;
        }
        seen.add(token);
        merged.push(token);
      }
    }
    return merged;
  }
}

function buildSearchableText(fact: Fact): string {
  return [fact.entity, fact.key, fact.value, fact.category, fact.source]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
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

function createFact(fact: FactOperationInput["fact"], fallbackSource: string, now: string): Fact {
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

function normalizeFact(raw: FactRow | Fact | null): Fact | null {
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
