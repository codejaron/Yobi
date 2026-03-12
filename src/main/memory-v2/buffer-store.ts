import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import type { BufferMessage, ChatRole } from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import {
  appendJsonlLine,
  readJsonlFile,
  writeJsonlFileAtomic
} from "@main/storage/fs";

export interface BufferCompactionResult {
  compacted: boolean;
  removed: BufferMessage[];
  sourceRanges: string[];
  archiveFiles: string[];
}

export class BufferStore {
  private loaded = false;
  private rows: BufferMessage[] = [];
  private idCounter = 0;

  constructor(private readonly paths: CompanionPaths) {}

  async init(): Promise<void> {
    if (this.loaded) {
      return;
    }
    const raw = await readJsonlFile<BufferMessage>(this.paths.bufferPath);
    this.rows = raw
      .map((row) => normalizeMessage(row))
      .filter((row): row is BufferMessage => row !== null)
      .sort((a, b) => a.id.localeCompare(b.id));
    this.idCounter = this.rows.reduce((max, row) => Math.max(max, parseNumericId(row.id)), 0);
    this.loaded = true;
  }

  listAll(): BufferMessage[] {
    return this.rows.map(cloneMessage);
  }

  listRecent(limit = 60): BufferMessage[] {
    const safe = Math.max(1, limit);
    return this.rows.slice(-safe).map(cloneMessage);
  }

  async append(input: {
    role: ChatRole;
    channel: "telegram" | "console" | "qq" | "feishu";
    text: string;
    meta?: Record<string, unknown>;
    ts?: string;
    allowEmpty?: boolean;
  }): Promise<BufferMessage> {
    await this.init();
    const text = input.text.trim();
    if (!text && !input.allowEmpty) {
      throw new Error("buffer message cannot be empty");
    }

    this.idCounter += 1;
    const message: BufferMessage = {
      id: `msg-${String(this.idCounter).padStart(6, "0")}`,
      ts:
        input.ts && Number.isFinite(new Date(input.ts).getTime())
          ? new Date(input.ts).toISOString()
          : new Date().toISOString(),
      role: input.role,
      channel: input.channel,
      text,
      meta: input.meta ? { ...input.meta } : undefined,
      extracted: false,
      extractionQueued: false
    };
    this.rows.push(message);
    await appendJsonlLine(this.paths.bufferPath, message);
    return cloneMessage(message);
  }

  async compactIfNeeded(input: { maxMessages: number; lowWatermark: number }): Promise<BufferCompactionResult> {
    await this.init();
    const maxMessages = Math.max(20, input.maxMessages);
    const lowWatermark = Math.max(10, Math.min(maxMessages - 1, input.lowWatermark));
    if (this.rows.length <= maxMessages) {
      return {
        compacted: false,
        removed: [],
        sourceRanges: [],
        archiveFiles: []
      };
    }

    const removeCount = Math.max(1, this.rows.length - lowWatermark);
    const removed = this.rows.slice(0, removeCount);
    this.rows = this.rows.slice(removeCount);
    const archiveFiles = await this.archiveMessages(removed);
    await this.appendToUnprocessed(removed.filter((row) => !row.extracted));
    await writeJsonlFileAtomic(this.paths.bufferPath, this.rows);

    return {
      compacted: true,
      removed: removed.map(cloneMessage),
      sourceRanges: buildSourceRanges(removed),
      archiveFiles
    };
  }

  async queueUnextractedMessages(minMessages = 1): Promise<BufferMessage[]> {
    await this.init();
    const queued = this.rows.filter((row) => !row.extracted && !row.extractionQueued);
    if (queued.length < Math.max(1, minMessages)) {
      return [];
    }

    for (const row of this.rows) {
      if (row.extracted || row.extractionQueued) {
        continue;
      }
      row.extractionQueued = true;
    }

    await this.appendToUnprocessed(queued);
    await writeJsonlFileAtomic(this.paths.bufferPath, this.rows);
    return queued.map(cloneMessage);
  }

  async markExtractedByRange(range: string): Promise<void> {
    await this.init();
    const [start, end] = splitRange(range);
    if (!start || !end) {
      return;
    }
    let changed = false;
    for (const row of this.rows) {
      if (row.id < start || row.id > end) {
        continue;
      }
      if (row.extracted) {
        continue;
      }
      row.extracted = true;
      row.extractionQueued = false;
      changed = true;
    }
    if (changed) {
      await writeJsonlFileAtomic(this.paths.bufferPath, this.rows);
    }
  }

  async dumpUnprocessed(): Promise<void> {
    await this.init();
    const pending = this.rows.filter((row) => !row.extracted);
    await writeJsonlFileAtomic(this.paths.unprocessedPath, pending);
  }

  async consumeUnprocessed(): Promise<BufferMessage[]> {
    const rows = await readJsonlFile<BufferMessage>(this.paths.unprocessedPath);
    const normalized = rows
      .map((row) => normalizeMessage(row))
      .filter((row): row is BufferMessage => row !== null);
    if (normalized.length > 0) {
      await writeJsonlFileAtomic(this.paths.unprocessedPath, []);
    }
    return normalized;
  }

  async clear(): Promise<void> {
    await this.init();
    this.rows = [];
    this.idCounter = 0;
    await writeJsonlFileAtomic(this.paths.bufferPath, []);
    await writeJsonlFileAtomic(this.paths.unprocessedPath, []);
  }

  private async appendToUnprocessed(messages: BufferMessage[]): Promise<void> {
    const normalized = messages
      .map((row) => normalizeMessage(row))
      .filter((row): row is BufferMessage => row !== null)
      .filter((row) => !row.extracted);
    if (normalized.length === 0) {
      return;
    }

    const current = (await readJsonlFile<BufferMessage>(this.paths.unprocessedPath))
      .map((row) => normalizeMessage(row))
      .filter((row): row is BufferMessage => row !== null);
    const merged = new Map<string, BufferMessage>();
    for (const row of [...current, ...normalized]) {
      merged.set(row.id, {
        ...row,
        extractionQueued: false
      });
    }
    await writeJsonlFileAtomic(
      this.paths.unprocessedPath,
      [...merged.values()].sort((left, right) => left.id.localeCompare(right.id))
    );
  }

  private async archiveMessages(messages: BufferMessage[]): Promise<string[]> {
    const grouped = new Map<string, BufferMessage[]>();
    for (const message of messages) {
      const dayKey = toDayKey(message.ts);
      const bucket = grouped.get(dayKey) ?? [];
      bucket.push(message);
      grouped.set(dayKey, bucket);
    }

    const touched: string[] = [];
    for (const [dayKey, bucket] of grouped.entries()) {
      const targetPath = path.join(this.paths.sessionArchiveDir, `${dayKey}.jsonl`);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      for (const row of bucket) {
        await appendJsonlLine(targetPath, row);
      }
      touched.push(targetPath);
    }
    return touched.sort();
  }
}

function normalizeMessage(raw: BufferMessage): BufferMessage | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const role = raw.role;
  const channel = raw.channel;
  if (
    role !== "system" &&
    role !== "user" &&
    role !== "assistant"
  ) {
    return null;
  }
  if (channel !== "telegram" && channel !== "console" && channel !== "qq" && channel !== "feishu") {
    return null;
  }
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  const meta = raw.meta && typeof raw.meta === "object" ? { ...raw.meta } : undefined;
  if (!text && !hasPersistableToolTraceMeta(meta)) {
    return null;
  }

  const id = typeof raw.id === "string" && raw.id ? raw.id : `msg-${String(randomUUID()).slice(0, 6)}`;
  const ts =
    typeof raw.ts === "string" && Number.isFinite(new Date(raw.ts).getTime())
      ? new Date(raw.ts).toISOString()
      : new Date().toISOString();
  return {
    id,
    ts,
    role,
    channel,
    text,
    meta,
    extracted: Boolean(raw.extracted),
    extractionQueued: Boolean(raw.extractionQueued)
  };
}

function cloneMessage(row: BufferMessage): BufferMessage {
  return {
    ...row,
    meta: row.meta ? { ...row.meta } : undefined
  };
}

function parseNumericId(id: string): number {
  const matched = /^msg-(\d+)$/.exec(id.trim());
  if (!matched) {
    return 0;
  }
  return Number(matched[1]) || 0;
}

function hasPersistableToolTraceMeta(meta: Record<string, unknown> | undefined): boolean {
  if (!meta) {
    return false;
  }

  const toolTrace = meta.toolTrace;
  return (
    typeof toolTrace === "object" &&
    toolTrace !== null &&
    Array.isArray((toolTrace as { items?: unknown }).items) &&
    (toolTrace as { items: unknown[] }).items.length > 0
  );
}

function buildSourceRanges(rows: BufferMessage[]): string[] {
  if (rows.length === 0) {
    return [];
  }
  const ranges: string[] = [];
  let start = rows[0]?.id;
  let previous = rows[0]?.id;
  for (let index = 1; index < rows.length; index += 1) {
    const current = rows[index]?.id;
    if (!current || !previous || !start) {
      continue;
    }
    const previousNum = parseNumericId(previous);
    const currentNum = parseNumericId(current);
    if (currentNum !== previousNum + 1) {
      ranges.push(`${start}..${previous}`);
      start = current;
    }
    previous = current;
  }
  if (start && previous) {
    ranges.push(`${start}..${previous}`);
  }
  return ranges;
}

function splitRange(range: string): [string | null, string | null] {
  const [start, end] = range.split("..");
  const normalizedStart = start?.trim() || null;
  const normalizedEnd = end?.trim() || normalizedStart;
  return [normalizedStart, normalizedEnd];
}

function toDayKey(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "1970-01-01";
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
