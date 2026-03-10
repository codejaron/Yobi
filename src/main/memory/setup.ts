import path from "node:path";
import { promises as fs } from "node:fs";
import type {
  AppConfig,
  BufferMessage,
  BrowseTopicMaterial,
  EmbedderRuntimeStatus,
  Episode,
  Fact,
  HistoryMessage,
  InterestProfile,
  TopicPoolItem,
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
import { TopicStore } from "@main/memory-v2/topic-store";
import { FactEmbeddingStore, type SemanticFactMatch } from "@main/memory-v2/fact-embeddings-store";
import { EmbedderService } from "@main/memory-v2/embedder";
import { extractQueryTerms, matchFacts } from "@main/memory-v2/retrieval";

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

interface PendingTopic extends TopicPoolItem {}

interface BufferCompactionSignal {
  removed: BufferMessage[];
  sourceRanges: string[];
}

export interface RelevantFactMatch extends SemanticFactMatch {
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
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    channel: message.channel,
    timestamp: message.ts,
    meta:
      typeof proactive === "boolean" || source === "claw" || source === "yobi"
        ? {
            proactive: typeof proactive === "boolean" ? proactive : undefined,
            source: source === "claw" || source === "yobi" ? source : undefined
          }
        : undefined
  };
}

export class YobiMemory {
  private readonly bufferStore: BufferStore;
  private readonly factsStore: FactsStore;
  private readonly profileStore: ProfileStore;
  private readonly episodesStore: EpisodesStore;
  private readonly topicStore: TopicStore;
  private readonly factEmbeddingStore: FactEmbeddingStore;
  private readonly embedder: EmbedderService;
  private initialized = false;
  private compactionSignals: BufferCompactionSignal[] = [];

  constructor(
    private readonly paths: CompanionPaths,
    private readonly getConfig: () => AppConfig
  ) {
    this.bufferStore = new BufferStore(paths);
    this.factsStore = new FactsStore(paths);
    this.profileStore = new ProfileStore(paths);
    this.episodesStore = new EpisodesStore(paths);
    this.topicStore = new TopicStore(paths);
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
    await this.topicStore.init();
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
    await this.bufferStore.append({
      role: input.role,
      channel: normalizeChannel(input.metadata?.channel),
      text: input.text,
      meta: input.metadata
    });
    const kernel = this.getConfig().kernel;
    const compaction = await this.bufferStore.compactIfNeeded({
      maxMessages: kernel.buffer.maxMessages,
      lowWatermark: kernel.buffer.lowWatermark
    });
    if (compaction.compacted && compaction.removed.length > 0) {
      this.compactionSignals.push({
        removed: compaction.removed,
        sourceRanges: compaction.sourceRanges
      });
    }
  }

  drainCompactionSignals(): BufferCompactionSignal[] {
    const current = this.compactionSignals;
    this.compactionSignals = [];
    return current;
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

  async addTopic(input: {
    text: string;
    source: string;
    expiresAt?: string | null;
    material?: BrowseTopicMaterial;
  }): Promise<boolean> {
    await this.init();
    return this.topicStore.addTopic({
      text: input.text,
      source: input.source,
      expiresAt: input.expiresAt,
      material: input.material
    });
  }

  async listActive(limit = 3): Promise<PendingTopic[]> {
    await this.init();
    return this.topicStore.listActive(limit);
  }

  async listTopicPool(limit = 20): Promise<TopicPoolItem[]> {
    await this.init();
    return this.topicStore.listTopicPool(limit);
  }

  async deleteTopic(topicId: string): Promise<boolean> {
    await this.init();
    return this.topicStore.deleteTopic(topicId.trim());
  }

  async clearTopicPool(): Promise<number> {
    await this.init();
    return this.topicStore.clearTopicPool();
  }

  async clearTopicsBySourcePrefixes(prefixes: string[]): Promise<number> {
    await this.init();
    return this.topicStore.clearBySourcePrefixes(prefixes);
  }

  async markUsed(topicId: string): Promise<void> {
    await this.init();
    await this.topicStore.markUsed(topicId.trim());
  }

  async countUnusedTopics(): Promise<number> {
    await this.init();
    return this.topicStore.countUnusedTopics();
  }

  async cleanup(): Promise<void> {
    await this.init();
    await this.topicStore.cleanup();
  }

  async getInterestProfile(): Promise<InterestProfile> {
    await this.init();
    return this.topicStore.getInterestProfile();
  }

  async saveInterestProfile(input: InterestProfile): Promise<InterestProfile> {
    await this.init();
    return this.topicStore.saveInterestProfile(input);
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
    return filtered.slice(offset, offset + limit);
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
    if (facts.length === 0 || !this.getConfig().memory.embedding.enabled) {
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
    if (!this.getConfig().memory.embedding.enabled) {
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

    const lexicalTerms = extractQueryTerms(input.queryTexts);
    const lexicalMatches = matchFacts(facts, lexicalTerms, limit);
    const merged = new Map<string, RelevantFactMatch>();

    for (const row of lexicalMatches) {
      merged.set(row.fact.id, {
        fact: row.fact,
        semanticHit: false,
        semanticScore: 0,
        lexicalHit: true,
        lexicalScore: row.score
      });
    }

    const embeddedQuery = await this.embedder.embed(input.queryTexts.join("\n"));
    if (embeddedQuery) {
      const semanticMatches = await this.factEmbeddingStore.search(
        facts,
        embeddedQuery.modelId,
        embeddedQuery.vector,
        this.getConfig().memory.embedding.similarityThreshold,
        limit
      );

      for (const row of semanticMatches) {
        const existing = merged.get(row.fact.id);
        merged.set(row.fact.id, {
          fact: row.fact,
          semanticHit: true,
          semanticScore: row.semanticScore,
          lexicalHit: existing?.lexicalHit ?? false,
          lexicalScore: existing?.lexicalScore ?? 0
        });
      }
    }

    return [...merged.values()]
      .sort((left, right) => {
        if (left.semanticHit !== right.semanticHit) {
          return left.semanticHit ? -1 : 1;
        }
        if (left.semanticScore !== right.semanticScore) {
          return right.semanticScore - left.semanticScore;
        }
        if (left.lexicalHit !== right.lexicalHit) {
          return left.lexicalHit ? -1 : 1;
        }
        if (left.lexicalScore !== right.lexicalScore) {
          return right.lexicalScore - left.lexicalScore;
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
    return this.embedder.getStatus();
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
