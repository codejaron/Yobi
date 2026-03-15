import path from "node:path";
import { promises as fs } from "node:fs";
import type {
  AppConfig,
  BufferMessage,
  EmbedderRuntimeStatus,
  Episode,
  Fact,
  HistoryMessage,
  HistoryMessageMeta,
  UserProfile
} from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import {
  fileExists,
  readJsonlFile
} from "@main/storage/fs";
import { BufferStore } from "@main/memory-v2/buffer-store";
import { FactsStore } from "@main/memory-v2/facts-store";
import { ProfileStore } from "@main/memory-v2/profile-store";
import { EpisodesStore } from "@main/memory-v2/episodes-store";
import { FactEmbeddingStore, type SemanticFactMatch } from "@main/memory-v2/fact-embeddings-store";
import { EmbedderService } from "@main/memory-v2/embedder";

interface MemoryResourceContext {
  threadId: string;
  resourceId: string;
}

interface ListHistoryInput extends MemoryResourceContext {
  query?: string;
  limit?: number;
  offset?: number;
}

interface CursorHistoryInput extends MemoryResourceContext {
  beforeId?: string;
  limit?: number;
}

export interface RelevantFactMatch extends SemanticFactMatch {
  finalScore: number;
  textScore: number;
  vectorScore: number;
  lexicalHit: boolean;
  lexicalScore: number;
  semanticHit: boolean;
}

function normalizeTopicText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function toHistoryMessage(message: BufferMessage): HistoryMessage {
  const source = message.meta?.source;
  const proactive = message.meta?.proactive;
  const toolTrace = message.meta?.toolTrace;
  const assistantTimeline = message.meta?.assistantTimeline;
  const meta: HistoryMessageMeta = {};

  if (typeof proactive === "boolean") {
    meta.proactive = proactive;
  }

  if (source === "yobi") {
    meta.source = "yobi";
  }

  if (
    toolTrace &&
    typeof toolTrace === "object" &&
    Array.isArray((toolTrace as { items?: unknown }).items)
  ) {
    meta.toolTrace = {
      items: (toolTrace as { items: NonNullable<HistoryMessageMeta["toolTrace"]>["items"] }).items
    };
  }

  if (
    assistantTimeline &&
    typeof assistantTimeline === "object" &&
    Array.isArray((assistantTimeline as { blocks?: unknown }).blocks)
  ) {
    meta.assistantTimeline = {
      blocks:
        (
          assistantTimeline as {
            blocks: NonNullable<HistoryMessageMeta["assistantTimeline"]>["blocks"];
          }
        ).blocks
    };
  }

  return {
    id: message.id,
    role: message.role,
    text: message.text,
    channel: message.channel,
    timestamp: message.ts,
    meta: Object.keys(meta).length > 0 ? meta : undefined
  };
}

export class YobiMemory {
  private readonly bufferStore: BufferStore;
  private readonly factsStore: FactsStore;
  private readonly profileStore: ProfileStore;
  private readonly episodesStore: EpisodesStore;
  private readonly factEmbeddingStore: FactEmbeddingStore;
  private readonly embedder: EmbedderService;
  private initialized = false;

  constructor(
    private readonly paths: CompanionPaths,
    private readonly getConfig: () => AppConfig
  ) {
    this.bufferStore = new BufferStore(paths);
    this.factsStore = new FactsStore(paths);
    this.profileStore = new ProfileStore(paths);
    this.episodesStore = new EpisodesStore(paths);
    this.factEmbeddingStore = new FactEmbeddingStore(paths);
    this.embedder = new EmbedderService(paths, getConfig);
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.bufferStore.init();
    await this.factsStore.init();
    await this.profileStore.init();
    await this.factEmbeddingStore.init();
    this.embedder.init();
    this.initialized = true;
  }

  async rememberMessage(input: {
    threadId: string;
    resourceId: string;
    role: "system" | "user" | "assistant";
    text: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.init();
    const allowEmpty =
      input.role === "assistant" &&
      typeof input.metadata?.toolTrace === "object" &&
      input.metadata?.toolTrace !== null;
    await this.bufferStore.append({
      role: input.role,
      channel: normalizeChannel(input.metadata?.channel),
      text: input.text,
      meta: input.metadata,
      allowEmpty
    });
    const kernel = this.getConfig().kernel;
    const compaction = await this.bufferStore.compactIfNeeded({
      maxMessages: kernel.buffer.maxMessages,
      lowWatermark: kernel.buffer.lowWatermark
    });
    if (compaction.compacted && compaction.removed.length > 0) {
      await this.profileStore.updateFromStatSignals(compaction.removed);
    }
  }

  async recall(input: MemoryResourceContext): Promise<{
    messages: Array<{
      id: string;
      role: "system" | "user" | "assistant";
      content: {
        content: string;
        metadata?: Record<string, unknown>;
      };
    }>;
  }> {
    await this.init();
    const messages = this.bufferStore.listRecent(Math.max(10, this.getConfig().memory.recentMessages));
    return {
      messages: messages.map((item) => ({
        id: item.id,
        role: item.role,
        content: {
          content: item.text,
          metadata: item.meta
        }
      }))
    };
  }

  async listHistory(input: ListHistoryInput): Promise<HistoryMessage[]> {
    await this.init();
    const all = await this.listAllMessages();
    const mapped = all.map((item) => toHistoryMessage(item));
    const query = input.query?.trim().toLowerCase();
    const filtered = query
      ? mapped.filter((item) => item.text.toLowerCase().includes(query))
      : mapped;
    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.max(1, Math.min(1000, input.limit ?? 100));
    return filtered.slice().reverse().slice(offset, offset + limit).reverse();
  }

  async listHistoryByCursor(input: CursorHistoryInput): Promise<{
    items: HistoryMessage[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    await this.init();
    const limit = Math.max(1, Math.min(100, input.limit ?? 20));
    const all = (await this.listAllMessages())
      .filter((item) => item.role === "user" || item.role === "assistant")
      .map((item) => toHistoryMessage(item));

    let base = all;
    if (input.beforeId) {
      const index = all.findIndex((item) => item.id === input.beforeId);
      base = index >= 0 ? all.slice(0, index) : all;
    }

    if (base.length === 0) {
      return {
        items: [],
        hasMore: false,
        nextCursor: null
      };
    }

    const startIndex = Math.max(0, base.length - limit);
    const items = base.slice(startIndex);
    const hasMore = startIndex > 0;
    return {
      items,
      hasMore,
      nextCursor: hasMore ? items[0]?.id ?? null : null
    };
  }

  async countHistory(_input: MemoryResourceContext): Promise<number> {
    await this.init();
    const all = await this.listAllMessages();
    return all.filter((item) => item.role === "user" || item.role === "assistant").length;
  }

  async clearThread(_input: MemoryResourceContext): Promise<void> {
    await this.init();
    await this.bufferStore.clear();
    await this.clearArchiveFiles();
  }

  async mapRecentToModelMessages(
    _input: MemoryResourceContext,
    limit = Math.max(10, this.getConfig().memory.recentMessages)
  ): Promise<Array<{ role: "system" | "user" | "assistant"; content: string }>> {
    await this.init();
    const boundedLimit = Math.max(1, limit);
    return this.bufferStore
      .listRecent(boundedLimit)
      .filter((message) => message.text.trim())
      .map((message) => ({
        role: message.role,
        content: message.text
      }))
      .slice(-boundedLimit);
  }

  async listRecentBufferMessages(limit = 60): Promise<BufferMessage[]> {
    await this.init();
    return this.bufferStore.listRecent(limit);
  }

  async listAllBufferMessages(): Promise<BufferMessage[]> {
    await this.init();
    return this.bufferStore.listAll();
  }

  async markExtractedByRange(range: string): Promise<void> {
    await this.init();
    await this.bufferStore.markExtractedByRange(range);
  }

  async dumpUnprocessedBuffer(): Promise<void> {
    await this.init();
    await this.bufferStore.dumpUnprocessed();
  }

  async consumeUnprocessedBuffer(): Promise<BufferMessage[]> {
    await this.init();
    return this.bufferStore.consumeUnprocessed();
  }

  async queuePendingBufferExtractions(minMessages: number): Promise<BufferMessage[]> {
    await this.init();
    return this.bufferStore.queueUnextractedMessages(minMessages);
  }

  async listFacts(): Promise<Fact[]> {
    await this.init();
    return this.factsStore.listActive();
  }

  async listFactArchive(): Promise<Fact[]> {
    await this.init();
    return this.factsStore.listArchive();
  }

  async getProfile(): Promise<UserProfile> {
    await this.init();
    return this.profileStore.getProfile();
  }

  async listRecentEpisodes(limit = 30): Promise<Episode[]> {
    await this.init();
    return this.episodesStore.listRecent(limit);
  }


  async touchFacts(ids: string[]): Promise<void> {
    await this.init();
    await this.factsStore.touch(ids);
  }

  async stop(): Promise<void> {
    await this.init();
    await this.bufferStore.dumpUnprocessed();
    await this.factEmbeddingStore.forceFlush();
  }


  async syncFactEmbeddings(facts: Fact[]): Promise<void> {
    await this.init();
    if (facts.length === 0 || !this.getConfig().memory.embedding.enabled || !this.isVectorAvailable()) {
      return;
    }

    const rows = [];
    for (const fact of facts) {
      const embedded = await this.embedder.embed(`${fact.entity} ${fact.key}: ${fact.value}`);
      if (!embedded) {
        continue;
      }
      rows.push({
        fact_id: fact.id,
        model_id: embedded.modelId,
        vector: embedded.vector,
        updated_at: new Date().toISOString()
      });
    }

    if (rows.length === 0) {
      return;
    }

    await this.factEmbeddingStore.upsert(rows);
    await this.factEmbeddingStore.flushIfDirty();
  }

  async backfillFactEmbeddings(limit = 10): Promise<void> {
    await this.init();
    if (!this.getConfig().memory.embedding.enabled || !this.isVectorAvailable()) {
      return;
    }

    const activeFacts = this.factsStore.listActive();
    const pendingFacts = await this.factEmbeddingStore.findPendingFacts(
      activeFacts,
      this.embedder.getCurrentModelId(),
      limit
    );
    if (pendingFacts.length === 0) {
      return;
    }

    await this.syncFactEmbeddings(pendingFacts);
  }

  async searchRelevantFacts(input: {
    queryTexts: string[];
    facts?: Fact[];
    limit?: number;
  }): Promise<RelevantFactMatch[]> {
    await this.init();
    const limit = Math.max(1, input.limit ?? 20);
    const facts = input.facts ?? this.factsStore.listActive();
    if (facts.length === 0) {
      return [];
    }

    const allowedIds = new Set(facts.map((fact) => fact.id));
    const retrievalConfig = this.getConfig().memory.retrieval;
    const candidateLimit = Math.max(limit, limit * retrievalConfig.candidateMultiplier);
    const lexicalMatches = (await this.factsStore.searchLexical(input.queryTexts, candidateLimit)).filter((row) =>
      allowedIds.has(row.fact.id)
    );
    const merged = new Map<string, RelevantFactMatch>();

    const lexicalScores = normalizeLexicalScores(lexicalMatches.map((row) => row.bm25Raw));

    lexicalMatches.forEach((row, index) => {
      merged.set(row.fact.id, {
        fact: row.fact,
        finalScore: 0,
        textScore: lexicalScores[index] ?? 0,
        vectorScore: 0,
        semanticHit: false,
        semanticScore: 0,
        lexicalHit: true,
        lexicalScore: row.bm25Raw
      });
    });

    const vectorAvailable = this.isVectorAvailable();
    const embeddedQuery = await this.embedder.embed(input.queryTexts.join("\n"));
    if (vectorAvailable && embeddedQuery && embeddedQuery.vector.length > 0) {
      const semanticMatches = await this.factEmbeddingStore.search(
        facts,
        embeddedQuery.modelId,
        embeddedQuery.vector,
        this.getConfig().memory.embedding.similarityThreshold,
        candidateLimit
      );

      for (const row of semanticMatches) {
        const existing = merged.get(row.fact.id);
        merged.set(row.fact.id, {
          fact: row.fact,
          finalScore: existing?.finalScore ?? 0,
          textScore: existing?.textScore ?? 0,
          vectorScore: row.semanticScore,
          semanticHit: true,
          semanticScore: row.semanticScore,
          lexicalHit: existing?.lexicalHit ?? false,
          lexicalScore: existing?.lexicalScore ?? 0
        });
      }
    }

    const vectorWeight = retrievalConfig.vectorWeight;
    const textWeight = retrievalConfig.textWeight;
    return [...merged.values()]
      .map((row) => ({
        ...row,
        finalScore: computeFinalScore({
          textScore: row.textScore,
          vectorScore: row.vectorScore,
          lexicalHit: row.lexicalHit,
          semanticHit: row.semanticHit,
          textWeight,
          vectorWeight
        })
      }))
      .sort((left, right) => {
        if (left.finalScore !== right.finalScore) {
          return right.finalScore - left.finalScore;
        }
        if (left.semanticHit !== right.semanticHit) {
          return left.semanticHit ? -1 : 1;
        }
        if (left.vectorScore !== right.vectorScore) {
          return right.vectorScore - left.vectorScore;
        }
        if (left.lexicalHit !== right.lexicalHit) {
          return left.lexicalHit ? -1 : 1;
        }
        if (left.textScore !== right.textScore) {
          return right.textScore - left.textScore;
        }
        if (left.fact.confidence !== right.fact.confidence) {
          return right.fact.confidence - left.fact.confidence;
        }
        return new Date(right.fact.updated_at).getTime() - new Date(left.fact.updated_at).getTime();
      })
      .slice(0, limit);
  }

  getFactEmbeddingStore(): FactEmbeddingStore {
    return this.factEmbeddingStore;
  }

  getEmbedderStatus(): EmbedderRuntimeStatus {
    const embedderStatus = this.embedder.getStatus();
    const lexicalStatus = this.factsStore.getLexicalStatus();
    const vectorAvailable = embedderStatus.status === "ready";
    if (lexicalStatus.available && vectorAvailable) {
      return {
        status: "ready",
        mode: "hybrid",
        downloadPending: embedderStatus.downloadPending,
        message: embedderStatus.message
      };
    }
    if (lexicalStatus.available) {
      return {
        status: "ready",
        mode: "bm25-only",
        downloadPending: embedderStatus.downloadPending,
        message: embedderStatus.message || lexicalStatus.message
      };
    }
    if (vectorAvailable) {
      return {
        status: "ready",
        mode: "vector-only",
        downloadPending: embedderStatus.downloadPending,
        message: lexicalStatus.message || embedderStatus.message
      };
    }
    return {
      status: embedderStatus.status,
      mode: embedderStatus.status === "disabled" ? "disabled" : "bm25-only",
      downloadPending: embedderStatus.downloadPending,
      message: lexicalStatus.message || embedderStatus.message
    };
  }

  isVectorAvailable(): boolean {
    return this.embedder.getStatus().status === "ready";
  }

  getFactsStore(): FactsStore {
    return this.factsStore;
  }

  getProfileStore(): ProfileStore {
    return this.profileStore;
  }

  getEpisodesStore(): EpisodesStore {
    return this.episodesStore;
  }

  getBufferStore(): BufferStore {
    return this.bufferStore;
  }

  private async listAllMessages(): Promise<BufferMessage[]> {
    const archiveRows = await this.listArchiveMessages();
    const bufferRows = this.bufferStore.listAll();
    return [...archiveRows, ...bufferRows].sort((a, b) => a.id.localeCompare(b.id));
  }

  private async listArchiveMessages(): Promise<BufferMessage[]> {
    const exists = await fileExists(this.paths.sessionArchiveDir);
    if (!exists) {
      return [];
    }
    const files = (await fs.readdir(this.paths.sessionArchiveDir))
      .filter((name) => name.endsWith(".jsonl"))
      .sort((a, b) => a.localeCompare(b));
    const rows: BufferMessage[] = [];
    for (const fileName of files) {
      const data = await readJsonlFile<BufferMessage>(path.join(this.paths.sessionArchiveDir, fileName));
      for (const row of data) {
        const normalized = normalizeBufferMessage(row);
        if (normalized) {
          rows.push(normalized);
        }
      }
    }
    return rows;
  }

  private async clearArchiveFiles(): Promise<void> {
    const exists = await fileExists(this.paths.sessionArchiveDir);
    if (!exists) {
      return;
    }
    const files = (await fs.readdir(this.paths.sessionArchiveDir)).filter((name) => name.endsWith(".jsonl"));
    for (const name of files) {
      await fs.unlink(path.join(this.paths.sessionArchiveDir, name));
    }
    await fs.writeFile(this.paths.unprocessedPath, "", "utf8");
  }
}

function normalizeChannel(value: unknown): "telegram" | "console" | "qq" | "feishu" {
  if (value === "telegram" || value === "qq" || value === "feishu") {
    return value;
  }
  return "console";
}

function normalizeBufferMessage(raw: BufferMessage): BufferMessage | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  if (raw.role !== "assistant" && raw.role !== "system" && raw.role !== "user") {
    return null;
  }
  if (
    raw.channel !== "telegram" &&
    raw.channel !== "console" &&
    raw.channel !== "qq" &&
    raw.channel !== "feishu"
  ) {
    return null;
  }
  const text = normalizeTopicText(raw.text);
  if (!text) {
    return null;
  }
  return {
    id: raw.id,
    ts: raw.ts,
    role: raw.role,
    channel: raw.channel,
    text,
    meta: raw.meta ? { ...raw.meta } : undefined,
    extracted: Boolean(raw.extracted)
  };
}

function normalizeLexicalScores(values: number[]): number[] {
  if (values.length === 0) {
    return [];
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (values.length >= 2 && max - min > 1e-9) {
    return values.map((value) => (value - min) / (max - min));
  }
  return values.map((value) => value / (1 + value));
}

function computeFinalScore(input: {
  textScore: number;
  vectorScore: number;
  lexicalHit: boolean;
  semanticHit: boolean;
  textWeight: number;
  vectorWeight: number;
}): number {
  if (input.lexicalHit && input.semanticHit) {
    return input.textScore * input.textWeight + input.vectorScore * input.vectorWeight;
  }
  if (input.semanticHit) {
    return input.vectorScore;
  }
  if (input.lexicalHit) {
    return input.textScore;
  }
  return 0;
}
