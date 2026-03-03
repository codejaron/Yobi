import { readJsonFile, writeJsonFile } from "@main/storage/fs";
import { CompanionPaths } from "@main/storage/paths";
import {
  DEFAULT_TOKEN_STATS_STATUS,
  TOKEN_USAGE_SOURCES,
  type TokenBucketSummary,
  type TokenSourceCounters,
  type TokenStatsStatus,
  type TokenUsageSource
} from "@shared/types";

const STATE_VERSION = 1;
const DEFAULT_RETENTION_DAYS = 90;

interface TokenDayBucketState extends TokenBucketSummary {}

interface TokenStatsStateDocument {
  version: number;
  retentionDays: number;
  days: Record<string, TokenDayBucketState>;
}

export interface TokenStoreRecordInput {
  source: TokenUsageSource;
  tokens: number;
  estimatedTokens: number;
  timestamp?: string | number | Date | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function toInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }

  return null;
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(parsed).toISOString();
}

function normalizeDayKey(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function resolveTimeZone(): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof timeZone === "string" && timeZone.trim() ? timeZone.trim() : "local";
}

function emptyState(): TokenStatsStateDocument {
  return {
    version: STATE_VERSION,
    retentionDays: DEFAULT_RETENTION_DAYS,
    days: {}
  };
}

function normalizeSourceCounters(value: unknown): TokenSourceCounters {
  const source = asRecord(value);
  if (!source) {
    return {
      tokens: 0,
      estimatedTokens: 0
    };
  }

  const tokens = Math.max(0, toInteger(source.tokens) ?? 0);
  const estimatedTokens = Math.max(0, Math.min(tokens, toInteger(source.estimatedTokens) ?? 0));

  return {
    tokens,
    estimatedTokens
  };
}

function normalizeBySource(
  value: unknown
): Partial<Record<TokenUsageSource, TokenSourceCounters>> {
  const bySourceRaw = asRecord(value);
  if (!bySourceRaw) {
    return {};
  }

  const bySource: Partial<Record<TokenUsageSource, TokenSourceCounters>> = {};
  for (const source of TOKEN_USAGE_SOURCES) {
    const counters = normalizeSourceCounters(bySourceRaw[source]);
    if (counters.tokens <= 0 && counters.estimatedTokens <= 0) {
      continue;
    }
    bySource[source] = counters;
  }

  return bySource;
}

function buildEmptyBucket(dayKey: string, date: Date): TokenDayBucketState {
  return {
    dayKey,
    timeZone: resolveTimeZone(),
    tzOffsetMinutes: -date.getTimezoneOffset(),
    totalTokens: 0,
    estimatedTokens: 0,
    bySource: {},
    updatedAt: new Date().toISOString()
  };
}

function normalizeDayBucket(dayKey: string, value: unknown): TokenDayBucketState {
  const raw = asRecord(value);
  if (!raw) {
    return buildEmptyBucket(dayKey, new Date());
  }

  const bySource = normalizeBySource(raw.bySource);
  const sourceTotal = Object.values(bySource).reduce((sum, item) => sum + item.tokens, 0);
  const sourceEstimatedTotal = Object.values(bySource).reduce(
    (sum, item) => sum + item.estimatedTokens,
    0
  );

  const totalTokens = Math.max(sourceTotal, Math.max(0, toInteger(raw.totalTokens) ?? 0));
  const estimatedTokens = Math.max(
    sourceEstimatedTotal,
    Math.max(0, Math.min(totalTokens, toInteger(raw.estimatedTokens) ?? 0))
  );

  return {
    dayKey,
    timeZone:
      typeof raw.timeZone === "string" && raw.timeZone.trim() ? raw.timeZone.trim() : resolveTimeZone(),
    tzOffsetMinutes: toInteger(raw.tzOffsetMinutes) ?? 0,
    totalTokens,
    estimatedTokens,
    bySource,
    updatedAt: normalizeTimestamp(raw.updatedAt) ?? new Date().toISOString()
  };
}

function normalizeState(value: unknown): TokenStatsStateDocument {
  const raw = asRecord(value);
  if (!raw) {
    return emptyState();
  }

  const retentionDays = Math.max(
    1,
    Math.min(3660, toInteger(raw.retentionDays) ?? DEFAULT_RETENTION_DAYS)
  );
  const daysRaw = asRecord(raw.days);
  const days: Record<string, TokenDayBucketState> = {};

  if (daysRaw) {
    for (const [rawKey, entry] of Object.entries(daysRaw)) {
      const dayKey = normalizeDayKey(rawKey);
      if (!dayKey) {
        continue;
      }

      days[dayKey] = normalizeDayBucket(dayKey, entry);
    }
  }

  return {
    version: STATE_VERSION,
    retentionDays,
    days
  };
}

function trimToRetention(state: TokenStatsStateDocument): void {
  const retentionDays = Math.max(1, state.retentionDays);
  const dayKeys = Object.keys(state.days).sort((a, b) => a.localeCompare(b));
  if (dayKeys.length <= retentionDays) {
    return;
  }

  const removeCount = dayKeys.length - retentionDays;
  for (let i = 0; i < removeCount; i += 1) {
    const target = dayKeys[i];
    if (!target) {
      continue;
    }
    delete state.days[target];
  }
}

function resolveDate(value: TokenStoreRecordInput["timestamp"]): Date {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isFinite(ms)) {
      return new Date(ms);
    }
    return new Date();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value);
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) {
      return new Date(parsed);
    }
  }

  return new Date();
}

export function localDayKey(value: Date | number = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toStatus(state: TokenStatsStateDocument): TokenStatsStatus {
  const days = Object.keys(state.days)
    .sort((a, b) => a.localeCompare(b))
    .map((dayKey) => state.days[dayKey])
    .filter((item): item is TokenDayBucketState => Boolean(item));

  let lastUpdatedAt: string | null = null;
  for (const day of days) {
    const current = new Date(day.updatedAt).getTime();
    const latest = lastUpdatedAt ? new Date(lastUpdatedAt).getTime() : 0;
    if (!lastUpdatedAt || (Number.isFinite(current) && current > latest)) {
      lastUpdatedAt = day.updatedAt;
    }
  }

  return {
    ...DEFAULT_TOKEN_STATS_STATUS,
    retentionDays: state.retentionDays,
    lastUpdatedAt,
    days
  };
}

export class TokenStatsStore {
  private state: TokenStatsStateDocument | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly paths: CompanionPaths) {}

  async record(input: TokenStoreRecordInput): Promise<void> {
    const tokens = Math.max(0, Math.floor(input.tokens));
    if (tokens <= 0) {
      return;
    }

    const estimatedTokens = Math.max(0, Math.min(tokens, Math.floor(input.estimatedTokens)));

    await this.enqueueWrite(async () => {
      const state = await this.ensureState();
      const date = resolveDate(input.timestamp);
      const dayKey = localDayKey(date);

      const bucket = state.days[dayKey] ?? buildEmptyBucket(dayKey, date);
      bucket.timeZone = resolveTimeZone();
      bucket.tzOffsetMinutes = -date.getTimezoneOffset();
      bucket.totalTokens += tokens;
      bucket.estimatedTokens += estimatedTokens;

      const sourceCounters = bucket.bySource[input.source] ?? {
        tokens: 0,
        estimatedTokens: 0
      };

      sourceCounters.tokens += tokens;
      sourceCounters.estimatedTokens += estimatedTokens;
      bucket.bySource[input.source] = sourceCounters;
      bucket.updatedAt = new Date().toISOString();

      state.days[dayKey] = bucket;
      trimToRetention(state);
      await this.persistState();
    });
  }

  async getStatus(): Promise<TokenStatsStatus> {
    await this.writeQueue;
    const state = await this.ensureState();
    return toStatus(state);
  }

  private enqueueWrite(task: () => Promise<void>): Promise<void> {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async ensureState(): Promise<TokenStatsStateDocument> {
    if (this.state) {
      return this.state;
    }

    const raw = await readJsonFile<unknown>(this.paths.tokenStatsStatePath, null);
    this.state = normalizeState(raw);
    trimToRetention(this.state);
    await this.persistState();
    return this.state;
  }

  private async persistState(): Promise<void> {
    if (!this.state) {
      return;
    }

    await writeJsonFile(this.paths.tokenStatsStatePath, this.state);
  }
}
