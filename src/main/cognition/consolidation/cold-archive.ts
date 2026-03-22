import { promises as fs } from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { CognitionConfig, ColdArchiveStats } from "@shared/cognition";
import type { CompanionPaths } from "@main/storage/paths";
import type { AppLogger } from "@main/services/logger";
import { appendJsonlLine, readJsonlFile } from "@main/storage/fs";
import { MemoryGraphStore } from "../graph/memory-graph";
import type { ArchiveReport, ArchivedNodeRecord, ColdIndexEntry, PendingRecallRecord } from "./types";

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
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

function monthKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  return `${year}-${month}`;
}

function archiveFilePath(baseDir: string, month: string): string {
  return path.join(baseDir, `${month}.jsonl.gz`);
}

interface ColdArchiveInput {
  paths: CompanionPaths;
  logger: Pick<AppLogger, "warn">;
  getCognitionConfig: () => CognitionConfig;
}

export class ColdArchive {
  private indexCache: ColdIndexEntry[] | null = null;
  private pendingRequests: number[][] = [];
  private processingQueue = false;
  private pendingRecalls: PendingRecallRecord[] = [];

  constructor(private readonly input: ColdArchiveInput) {}

  async migrateNodes(input: {
    candidateIds: string[];
    graph: MemoryGraphStore;
    startIndex: number;
    checkpointInterval: number;
    onCheckpoint?: (lastProcessedIndex: number) => Promise<void> | void;
    shouldInterrupt?: () => boolean;
  }): Promise<ArchiveReport> {
    let migratedCount = 0;
    let lastProcessedIndex = input.startIndex - 1;

    for (let index = input.startIndex; index < input.candidateIds.length; index += 1) {
      if (input.shouldInterrupt?.()) {
        break;
      }

      const nodeId = input.candidateIds[index]!;
      const node = input.graph.getNode(nodeId);
      if (!node) {
        lastProcessedIndex = index;
        continue;
      }

      const edges = input.graph.getAllEdges().filter((edge) => edge.source === nodeId || edge.target === nodeId);
      await this.appendArchiveRecord({
        node,
        edges,
        archived_at: new Date().toISOString()
      });
      input.graph.removeNodes([nodeId]);
      migratedCount += 1;
      lastProcessedIndex = index;

      if ((index + 1) % input.checkpointInterval === 0) {
        await Promise.resolve(input.onCheckpoint?.(index));
      }
    }

    return {
      migratedCount,
      excludedByAbstraction: 0,
      orphansMigrated: 0,
      lastProcessedIndex
    };
  }

  requestAsyncRecall(seedEmbedding: number[]): void {
    if (seedEmbedding.length === 0) {
      return;
    }
    this.pendingRequests.push([...seedEmbedding]);
    if (this.processingQueue) {
      return;
    }
    this.processingQueue = true;
    setImmediate(() => {
      void this.processRecallQueue();
    });
  }

  consumePendingRecall(): PendingRecallRecord | null {
    return this.pendingRecalls.shift() ?? null;
  }

  invalidateIndexCache(): void {
    this.indexCache = null;
  }

  async getArchiveStats(): Promise<ColdArchiveStats> {
    await fs.mkdir(this.input.paths.cognitionColdArchiveDir, { recursive: true });
    const names = await fs.readdir(this.input.paths.cognitionColdArchiveDir);
    const archiveNames = names.filter((name) => /^\d{4}-\d{2}\.jsonl\.gz$/.test(name)).sort();

    let totalNodes = 0;
    let totalSizeBytes = 0;
    for (const name of archiveNames) {
      const filePath = archiveFilePath(this.input.paths.cognitionColdArchiveDir, name.replace(/\.jsonl\.gz$/, ""));
      const buffer = await fs.readFile(filePath);
      totalSizeBytes += buffer.byteLength;
      totalNodes += this.countArchiveRows(buffer);
    }

    return {
      totalNodes,
      totalSizeBytes,
      oldestMonth: archiveNames[0]?.replace(/\.jsonl\.gz$/, "") ?? null,
      newestMonth: archiveNames[archiveNames.length - 1]?.replace(/\.jsonl\.gz$/, "") ?? null
    };
  }

  private async appendArchiveRecord(record: ArchivedNodeRecord): Promise<void> {
    const month = monthKey(record.node.created_at);
    const filePath = archiveFilePath(this.input.paths.cognitionColdArchiveDir, month);
    const nextLine = `${JSON.stringify(record)}\n`;
    const previous = await this.readArchiveText(filePath);
    await fs.mkdir(this.input.paths.cognitionColdArchiveDir, { recursive: true });
    await fs.writeFile(filePath, gzipSync(`${previous}${nextLine}`));
    await appendJsonlLine(this.input.paths.cognitionColdArchiveIndexPath, {
      id: record.node.id,
      embedding: record.node.embedding,
      month,
      created_at: record.node.created_at,
      content_preview: record.node.content.slice(0, 50)
    } satisfies ColdIndexEntry);
    this.invalidateIndexCache();
  }

  private async processRecallQueue(): Promise<void> {
    try {
      while (this.pendingRequests.length > 0) {
        const query = this.pendingRequests.shift();
        if (!query) {
          continue;
        }
        const index = await this.loadIndex();
        const candidateMonths = this.buildAllowedMonths();
        const best = index
          .filter((entry) => candidateMonths.has(entry.month))
          .map((entry) => ({
            entry,
            score: cosineSimilarity(entry.embedding, query)
          }))
          .sort((left, right) => right.score - left.score)[0];
        if (!best || best.score < this.input.getCognitionConfig().consolidation.cold_recall_similarity_threshold) {
          continue;
        }
        const record = await this.findArchivedRecord(best.entry.month, best.entry.id);
        if (record) {
          this.pendingRecalls.push({
            node: record.node,
            edges: record.edges
          });
        }
      }
    } catch (error) {
      this.input.logger.warn("cognition", "cold-recall-queue-failed", undefined, error);
    } finally {
      this.processingQueue = false;
    }
  }

  private async loadIndex(): Promise<ColdIndexEntry[]> {
    if (this.indexCache) {
      return this.indexCache;
    }
    const rows = await readJsonlFile<ColdIndexEntry>(this.input.paths.cognitionColdArchiveIndexPath);
    this.indexCache = rows;
    return rows;
  }

  private async findArchivedRecord(month: string, id: string): Promise<ArchivedNodeRecord | null> {
    const filePath = archiveFilePath(this.input.paths.cognitionColdArchiveDir, month);
    const text = await this.readArchiveText(filePath);
    if (!text.trim()) {
      return null;
    }

    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as ArchivedNodeRecord;
        if (parsed.node.id === id) {
          return parsed;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private async readArchiveText(filePath: string): Promise<string> {
    try {
      const raw = await fs.readFile(filePath);
      if (raw.byteLength === 0) {
        return "";
      }
      return gunzipSync(raw).toString("utf8");
    } catch {
      return "";
    }
  }

  private countArchiveRows(buffer: Buffer): number {
    if (buffer.byteLength === 0) {
      return 0;
    }
    const text = gunzipSync(buffer).toString("utf8").trim();
    if (!text) {
      return 0;
    }
    return text.split(/\r?\n/).filter(Boolean).length;
  }

  private buildAllowedMonths(): Set<string> {
    const lookback = Math.max(1, this.input.getCognitionConfig().consolidation.cold_recall_months_lookback);
    const allowed = new Set<string>();
    const cursor = new Date();
    cursor.setUTCDate(1);
    cursor.setUTCHours(0, 0, 0, 0);
    for (let index = 0; index < lookback; index += 1) {
      allowed.add(monthKey(cursor.getTime()));
      cursor.setUTCMonth(cursor.getUTCMonth() - 1);
    }
    return allowed;
  }
}
