import path from "node:path";
import { promises as fs } from "node:fs";
import type { ModelMessage } from "ai";
import type {
  AttachmentReferenceNote,
  AppConfig,
  BufferMessage,
  ChatAttachment,
  EmbedderRuntimeStatus,
  Episode,
  Fact,
  HistoryMessage,
  HistoryMessageMeta,
  UserProfile
} from "@shared/types";
import { KERNEL_RUNTIME_DEFAULTS } from "@shared/runtime-tuning";
import { CompanionPaths } from "@main/storage/paths";
import {
  ATTACHMENT_REUSE_USER_MESSAGE_WINDOW,
  buildUserContentWithAttachments
} from "@main/services/chat-media";
import { supportsAllChatAttachments } from "@main/core/provider-utils";
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

type HistoryCursorSource = "buffer" | "archive";

interface PersistedHistoryCursor {
  version: 1;
  source: HistoryCursorSource;
  beforeId: string;
  fileName?: string;
}

interface HistoryCursorEntry {
  row: BufferMessage;
  cursor: PersistedHistoryCursor;
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

function readAttachments(meta?: Record<string, unknown>): ChatAttachment[] {
  return Array.isArray(meta?.attachments) ? (meta.attachments as ChatAttachment[]) : [];
}

function readAttachmentReferences(meta?: Record<string, unknown>): AttachmentReferenceNote[] {
  return Array.isArray(meta?.attachmentReferences)
    ? (meta.attachmentReferences as AttachmentReferenceNote[])
    : [];
}

function toHistoryMessage(message: BufferMessage): HistoryMessage {
  const source = message.meta?.source;
  const proactive = message.meta?.proactive;
  const toolTrace = message.meta?.toolTrace;
  const assistantTimeline = message.meta?.assistantTimeline;
  const attachments = readAttachments(message.meta);
  const attachmentReferences = readAttachmentReferences(message.meta);
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

  if (attachments.length > 0) {
    meta.attachments = attachments;
  }

  if (attachmentReferences.length > 0) {
    meta.attachmentReferences = attachmentReferences;
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

function isPersistedHistoryRow(message: BufferMessage): boolean {
  return message.role === "user" || message.role === "assistant";
}

function createBufferHistoryCursor(beforeId: string): PersistedHistoryCursor {
  return {
    version: 1,
    source: "buffer",
    beforeId
  };
}

function createArchiveHistoryCursor(beforeId: string, fileName: string): PersistedHistoryCursor {
  return {
    version: 1,
    source: "archive",
    beforeId,
    fileName
  };
}

function encodeHistoryCursor(cursor: PersistedHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeHistoryCursor(token: string): PersistedHistoryCursor | null {
  try {
    const decoded = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Partial<PersistedHistoryCursor>;
    if (decoded.version !== 1) {
      return null;
    }
    if (decoded.source !== "buffer" && decoded.source !== "archive") {
      return null;
    }
    if (typeof decoded.beforeId !== "string" || !decoded.beforeId.trim()) {
      return null;
    }
    if (decoded.source === "archive") {
      if (typeof decoded.fileName !== "string" || !decoded.fileName.endsWith(".jsonl")) {
        return null;
      }
      return {
        version: 1,
        source: "archive",
        beforeId: decoded.beforeId,
        fileName: decoded.fileName
      };
    }

    return {
      version: 1,
      source: "buffer",
      beforeId: decoded.beforeId
    };
  } catch {
    return null;
  }
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
    this.embedder = new EmbedderService(paths, () => this.getConfig().memory.embedding.enabled);
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
      (
        input.role === "assistant" &&
        typeof input.metadata?.toolTrace === "object" &&
        input.metadata?.toolTrace !== null
      ) ||
      (
        input.role === "user" &&
        Array.isArray(input.metadata?.attachments) &&
        input.metadata.attachments.length > 0
      );
    await this.bufferStore.append({
      role: input.role,
      channel: normalizeChannel(input.metadata?.channel),
      text: input.text,
      meta: input.metadata,
      allowEmpty
    });
    const compaction = await this.bufferStore.compactIfNeeded({
      maxMessages: KERNEL_RUNTIME_DEFAULTS.buffer.maxMessages,
      lowWatermark: KERNEL_RUNTIME_DEFAULTS.buffer.lowWatermark
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
    const limit = Math.max(1, Math.min(10_000, input.limit ?? 20));
    const requestedEntries = input.beforeId
      ? await this.collectHistoryEntriesBeforeCursor(input.beforeId, limit + 1)
      : await this.collectLatestHistoryEntries(limit + 1);

    if (requestedEntries.length === 0) {
      return {
        items: [],
        hasMore: false,
        nextCursor: null
      };
    }

    const hasMore = requestedEntries.length > limit;
    const visibleEntries = hasMore ? requestedEntries.slice(0, limit) : requestedEntries;
    return {
      items: visibleEntries.map((entry) => toHistoryMessage(entry.row)).reverse(),
      hasMore,
      nextCursor: hasMore ? encodeHistoryCursor(visibleEntries[visibleEntries.length - 1]!.cursor) : null
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
  ): Promise<ModelMessage[]> {
    await this.init();
    const boundedLimit = Math.max(1, limit);
    const recent = this.bufferStore.listRecent(boundedLimit);
    let activeAttachmentMessageId: string | null = null;

    for (let index = recent.length - 1; index >= 0; index -= 1) {
      const message = recent[index];
      if (message.role !== "user") {
        continue;
      }

      const attachments = readAttachments(message.meta);
      if (attachments.length === 0) {
        continue;
      }

      const laterUserCount = recent
        .slice(index + 1)
        .filter((candidate) => candidate.role === "user").length;
      if (laterUserCount <= ATTACHMENT_REUSE_USER_MESSAGE_WINDOW) {
        activeAttachmentMessageId = message.id;
      }
      break;
    }

    const messages: ModelMessage[] = [];
    for (const message of recent) {
      if (message.role === "user") {
        const attachments = readAttachments(message.meta);
        const built = await buildUserContentWithAttachments({
          text: message.text,
          attachments,
          includeMedia:
            attachments.length > 0 &&
            message.id === activeAttachmentMessageId &&
            supportsAllChatAttachments(this.getConfig(), attachments),
          fallbackReason:
            message.id === activeAttachmentMessageId &&
            attachments.length > 0 &&
            !supportsAllChatAttachments(this.getConfig(), attachments)
              ? "unsupported"
              : "expired"
        });
        const hasContent =
          typeof built.content === "string" ? built.content.trim().length > 0 : built.content.length > 0;
        if (!hasContent) {
          continue;
        }

        messages.push({
          role: "user",
          content: built.content
        });
        continue;
      }

      if (!message.text.trim()) {
        continue;
      }

      messages.push({
        role: message.role,
        content: message.text
      });
    }

    return messages.slice(-boundedLimit);
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

  async embedText(text: string): Promise<number[] | null> {
    await this.init();
    const embedded = await this.embedder.embed(text);
    return embedded?.vector ?? null;
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
    if (!this.initialized) {
      return;
    }

    try {
      await this.bufferStore.dumpUnprocessed();
      await this.factEmbeddingStore.forceFlush();
    } finally {
      try {
        await this.factsStore.close();
      } finally {
        this.initialized = false;
      }
    }
  }

  refreshEmbeddingRuntime(): void {
    this.embedder.refresh();
  }


  async syncFactEmbeddings(facts: Fact[]): Promise<void> {
    await this.init();
    if (facts.length === 0 || !this.isVectorAvailable()) {
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
    if (!this.isVectorAvailable()) {
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
    if (embedderStatus.status === "disabled") {
      return {
        status: "disabled",
        mode: "disabled",
        downloadPending: false,
        message: ""
      };
    }
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
      mode: "bm25-only",
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

  private async collectLatestHistoryEntries(limit: number): Promise<HistoryCursorEntry[]> {
    const collected: HistoryCursorEntry[] = [];
    this.appendHistoryEntriesFromRowsDescending({
      collected,
      rows: this.bufferStore.listAll(),
      source: "buffer",
      limit
    });
    if (collected.length >= limit) {
      return collected;
    }

    const archiveFiles = await this.listArchiveFileNamesDescending();
    for (const fileName of archiveFiles) {
      const rows = await this.readArchiveMessagesFromFile(fileName);
      this.appendHistoryEntriesFromRowsDescending({
        collected,
        rows,
        source: "archive",
        fileName,
        limit
      });
      if (collected.length >= limit) {
        break;
      }
    }

    return collected;
  }

  private async collectHistoryEntriesBeforeCursor(cursorToken: string, limit: number): Promise<HistoryCursorEntry[]> {
    const cursor = decodeHistoryCursor(cursorToken);
    if (!cursor) {
      return [];
    }

    const primary =
      cursor.source === "buffer"
        ? await this.collectHistoryEntriesBeforeBufferCursor(cursor, limit)
        : await this.collectHistoryEntriesBeforeArchiveCursor(cursor, limit);
    if (primary !== null) {
      return primary;
    }

    return this.collectHistoryEntriesByScanningBeforeId(cursor.beforeId, limit);
  }

  private async collectHistoryEntriesBeforeBufferCursor(
    cursor: PersistedHistoryCursor,
    limit: number
  ): Promise<HistoryCursorEntry[] | null> {
    const rows = this.bufferStore.listAll();
    const anchorIndex = rows.findIndex((row) => row.id === cursor.beforeId);
    if (anchorIndex < 0) {
      return null;
    }

    const collected: HistoryCursorEntry[] = [];
    this.appendHistoryEntriesFromRowsDescending({
      collected,
      rows,
      source: "buffer",
      limit,
      startIndex: anchorIndex - 1
    });
    if (collected.length >= limit) {
      return collected;
    }

    const archiveFiles = await this.listArchiveFileNamesDescending();
    for (const fileName of archiveFiles) {
      const archiveRows = await this.readArchiveMessagesFromFile(fileName);
      this.appendHistoryEntriesFromRowsDescending({
        collected,
        rows: archiveRows,
        source: "archive",
        fileName,
        limit
      });
      if (collected.length >= limit) {
        break;
      }
    }

    return collected;
  }

  private async collectHistoryEntriesBeforeArchiveCursor(
    cursor: PersistedHistoryCursor,
    limit: number
  ): Promise<HistoryCursorEntry[] | null> {
    const fileName = cursor.fileName;
    if (!fileName) {
      return null;
    }

    const archiveFiles = await this.listArchiveFileNamesDescending();
    const fileIndex = archiveFiles.indexOf(fileName);
    if (fileIndex < 0) {
      return null;
    }

    const collected: HistoryCursorEntry[] = [];
    for (let index = fileIndex; index < archiveFiles.length; index += 1) {
      const currentFile = archiveFiles[index]!;
      const rows = await this.readArchiveMessagesFromFile(currentFile);
      let startIndex = rows.length - 1;
      if (index === fileIndex) {
        const anchorIndex = rows.findIndex((row) => row.id === cursor.beforeId);
        if (anchorIndex < 0) {
          return null;
        }
        startIndex = anchorIndex - 1;
      }
      this.appendHistoryEntriesFromRowsDescending({
        collected,
        rows,
        source: "archive",
        fileName: currentFile,
        limit,
        startIndex
      });
      if (collected.length >= limit) {
        break;
      }
    }

    return collected;
  }

  private async collectHistoryEntriesByScanningBeforeId(beforeId: string, limit: number): Promise<HistoryCursorEntry[]> {
    let foundAnchor = false;
    const collected: HistoryCursorEntry[] = [];

    const bufferRows = this.bufferStore.listAll();
    for (let index = bufferRows.length - 1; index >= 0 && collected.length < limit; index -= 1) {
      const row = bufferRows[index]!;
      if (!foundAnchor) {
        foundAnchor = row.id === beforeId;
        continue;
      }
      if (!isPersistedHistoryRow(row)) {
        continue;
      }
      collected.push({
        row,
        cursor: createBufferHistoryCursor(row.id)
      });
    }

    const archiveFiles = await this.listArchiveFileNamesDescending();
    for (const fileName of archiveFiles) {
      if (collected.length >= limit) {
        break;
      }
      const rows = await this.readArchiveMessagesFromFile(fileName);
      for (let index = rows.length - 1; index >= 0 && collected.length < limit; index -= 1) {
        const row = rows[index]!;
        if (!foundAnchor) {
          foundAnchor = row.id === beforeId;
          continue;
        }
        if (!isPersistedHistoryRow(row)) {
          continue;
        }
        collected.push({
          row,
          cursor: createArchiveHistoryCursor(row.id, fileName)
        });
      }
    }

    return foundAnchor ? collected : [];
  }

  private async listAllMessages(): Promise<BufferMessage[]> {
    const archiveRows = await this.listArchiveMessages();
    const bufferRows = this.bufferStore.listAll();
    return [...archiveRows, ...bufferRows].sort((a, b) => a.id.localeCompare(b.id));
  }

  private async listArchiveMessages(): Promise<BufferMessage[]> {
    const files = (await this.listArchiveFileNamesDescending()).slice().reverse();
    const rows: BufferMessage[] = [];
    for (const fileName of files) {
      rows.push(...(await this.readArchiveMessagesFromFile(fileName)));
    }
    return rows;
  }

  private async listArchiveFileNamesDescending(): Promise<string[]> {
    const exists = await fileExists(this.paths.sessionArchiveDir);
    if (!exists) {
      return [];
    }

    return (await fs.readdir(this.paths.sessionArchiveDir))
      .filter((name) => name.endsWith(".jsonl"))
      .sort((left, right) => right.localeCompare(left));
  }

  private async readArchiveMessagesFromFile(fileName: string): Promise<BufferMessage[]> {
    const data = await readJsonlFile<BufferMessage>(path.join(this.paths.sessionArchiveDir, fileName));
    const rows: BufferMessage[] = [];
    for (const row of data) {
      const normalized = normalizeBufferMessage(row);
      if (normalized) {
        rows.push(normalized);
      }
    }
    return rows;
  }

  private appendHistoryEntriesFromRowsDescending(input: {
    collected: HistoryCursorEntry[];
    rows: BufferMessage[];
    source: HistoryCursorSource;
    limit: number;
    fileName?: string;
    startIndex?: number;
  }): void {
    const startIndex = input.startIndex ?? input.rows.length - 1;
    for (let index = startIndex; index >= 0 && input.collected.length < input.limit; index -= 1) {
      const row = input.rows[index];
      if (!row || !isPersistedHistoryRow(row)) {
        continue;
      }
      input.collected.push({
        row,
        cursor:
          input.source === "buffer"
            ? createBufferHistoryCursor(row.id)
            : createArchiveHistoryCursor(row.id, input.fileName!)
      });
    }
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
