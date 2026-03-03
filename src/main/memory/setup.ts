import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import type { Client as LibsqlClient } from "@libsql/client";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import type { MastraDBMessage } from "@mastra/core/agent";
import type { MemoryConfig } from "@mastra/core/memory";
import type {
  AppConfig,
  BrowseTopicMaterial,
  CharacterProfile,
  HistoryMessage,
  InterestProfile,
  TopicPoolItem,
  WorkingMemoryDocument
} from "@shared/types";
import { DEFAULT_WORKING_MEMORY_TEMPLATE } from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import { createModelForProvider } from "@main/core/model-factory";

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

interface PendingTopic {
  id: string;
  text: string;
  source: string;
  createdAt: string;
  expiresAt: string | null;
  used: boolean;
  material?: BrowseTopicMaterial;
}

interface TextPart {
  type: "text";
  text: string;
}

function isTextPart(value: unknown): value is TextPart {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as {
    type?: unknown;
    text?: unknown;
  };

  return candidate.type === "text" && typeof candidate.text === "string";
}

function normalizeRole(role: MastraDBMessage["role"]): "system" | "user" | "assistant" {
  if (role === "assistant" || role === "user" || role === "system") {
    return role;
  }
  return "assistant";
}

function normalizeTopicText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function parseSqlCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

const INTEREST_PROFILE_ID = "primary";
const EMPTY_INTEREST_PROFILE: InterestProfile = {
  games: [],
  creators: [],
  domains: [],
  dislikes: [],
  keywords: [],
  updatedAt: new Date(0).toISOString()
};

function normalizeInterestList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }

    const text = item.trim();
    if (!text) {
      continue;
    }
    unique.add(text.slice(0, 80));
    if (unique.size >= 64) {
      break;
    }
  }

  return [...unique];
}

function normalizeInterestProfile(raw: unknown): InterestProfile {
  if (!raw || typeof raw !== "object") {
    return {
      ...EMPTY_INTEREST_PROFILE
    };
  }

  const value = raw as Record<string, unknown>;
  const updatedAt =
    typeof value.updatedAt === "string" && Number.isFinite(new Date(value.updatedAt).getTime())
      ? new Date(value.updatedAt).toISOString()
      : new Date().toISOString();

  return {
    games: normalizeInterestList(value.games),
    creators: normalizeInterestList(value.creators),
    domains: normalizeInterestList(value.domains),
    dislikes: normalizeInterestList(value.dislikes),
    keywords: normalizeInterestList(value.keywords),
    updatedAt
  };
}

function normalizeTopComments(value: unknown): BrowseTopicMaterial["topComments"] {
  if (!Array.isArray(value)) {
    return [];
  }

  const deduped = new Map<string, number>();
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const row = item as Record<string, unknown>;
    const text = typeof row.text === "string" ? normalizeTopicText(row.text) : "";
    if (!text || text.length < 2) {
      continue;
    }

    const likesRaw = row.likes;
    const likes =
      typeof likesRaw === "number" && Number.isFinite(likesRaw)
        ? Math.max(0, Math.floor(likesRaw))
        : typeof likesRaw === "string"
          ? Math.max(0, Math.floor(Number(likesRaw) || 0))
          : 0;

    const previous = deduped.get(text) ?? 0;
    deduped.set(text, Math.max(previous, likes));

    if (deduped.size >= 20) {
      break;
    }
  }

  return [...deduped.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([text, likes]) => ({
      text,
      likes
    }));
}

function normalizeBrowseTopicMaterial(raw: unknown): BrowseTopicMaterial | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const value = raw as Record<string, unknown>;
  const bvid = typeof value.bvid === "string" ? value.bvid.trim() : "";
  const title = typeof value.title === "string" ? normalizeTopicText(value.title) : "";
  const up = typeof value.up === "string" ? normalizeTopicText(value.up) : "";
  const url = typeof value.url === "string" ? value.url.trim() : "";
  if (!bvid || !title || !up || !url) {
    return undefined;
  }

  const tags = Array.isArray(value.tags)
    ? value.tags
        .map((item) => (typeof item === "string" ? normalizeTopicText(item) : ""))
        .filter(Boolean)
        .slice(0, 12)
    : [];

  const topComments = normalizeTopComments(value.topComments);
  const playsRaw = value.plays;
  const plays =
    typeof playsRaw === "number" && Number.isFinite(playsRaw)
      ? Math.max(0, Math.floor(playsRaw))
      : typeof playsRaw === "string"
        ? Math.max(0, Math.floor(Number(playsRaw) || 0))
        : undefined;
  const duration = typeof value.duration === "string" ? value.duration.trim() : undefined;
  const publishedAtRaw = typeof value.publishedAt === "string" ? value.publishedAt.trim() : "";
  const publishedAt = publishedAtRaw && Number.isFinite(new Date(publishedAtRaw).getTime()) ? publishedAtRaw : undefined;
  const desc = typeof value.desc === "string" ? value.desc.trim() : undefined;

  return {
    bvid,
    title,
    up,
    tags,
    plays,
    duration: duration || undefined,
    publishedAt,
    desc: desc || undefined,
    topComments,
    url
  };
}

function extractTextFromMessage(message: MastraDBMessage): string {
  const rawContent = message.content;
  if (typeof rawContent?.content === "string" && rawContent.content.trim().length > 0) {
    return rawContent.content.trim();
  }

  const textParts = rawContent?.parts
    ?.filter((part): part is TextPart => isTextPart(part))
    .map((part) => part.text.trim())
    .filter(Boolean);

  if (textParts && textParts.length > 0) {
    return textParts.join("\n").trim();
  }

  return "";
}

function toHistoryMessage(message: MastraDBMessage): HistoryMessage | null {
  const text = extractTextFromMessage(message);
  if (!text) {
    return null;
  }

  const metadata = message.content?.metadata ?? {};
  const channel =
    metadata.channel === "telegram" ? "telegram" : metadata.channel === "qq" ? "qq" : "console";
  const source: "claw" | "yobi" | undefined =
    metadata.source === "claw" ? "claw" : metadata.source === "yobi" ? "yobi" : undefined;
  const meta =
    typeof metadata.proactive === "boolean" || source
      ? {
          proactive: typeof metadata.proactive === "boolean" ? metadata.proactive : undefined,
          source
        }
      : undefined;

  return {
    id: message.id,
    role: normalizeRole(message.role),
    text,
    channel,
    timestamp:
      message.createdAt instanceof Date
        ? message.createdAt.toISOString()
        : new Date(message.createdAt).toISOString(),
    meta
  };
}

function createMessage(input: {
  threadId: string;
  resourceId: string;
  role: "system" | "user" | "assistant";
  text: string;
  metadata?: Record<string, unknown>;
}): MastraDBMessage {
  const text = input.text.trim();
  return {
    id: randomUUID(),
    role: input.role,
    threadId: input.threadId,
    resourceId: input.resourceId,
    createdAt: new Date(),
    content: {
      format: 2,
      content: text,
      parts: [
        {
          type: "text",
          text
        }
      ],
      metadata: input.metadata
    }
  };
}

export class YobiMemory {
  private memory: Memory | null = null;
  private storage: LibSQLStore | null = null;
  private memoryKey = "";
  private topicClient: LibsqlClient | null = null;
  private topicTableReady = false;

  constructor(
    private readonly paths: CompanionPaths,
    private readonly getConfig: () => AppConfig,
    private readonly getCharacter: () => Promise<CharacterProfile>
  ) {}

  async rememberMessage(input: {
    threadId: string;
    resourceId: string;
    role: "system" | "user" | "assistant";
    text: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const memory = await this.ensureMemory();
    await this.ensureThreadExists({
      threadId: input.threadId,
      resourceId: input.resourceId
    });

    await memory.saveMessages({
      messages: [
        createMessage({
          threadId: input.threadId,
          resourceId: input.resourceId,
          role: input.role,
          text: input.text,
          metadata: input.metadata
        })
      ],
      memoryConfig: this.buildMemoryConfig(await this.getCharacter())
    });
  }

  async recall(input: MemoryResourceContext): Promise<{
    messages: MastraDBMessage[];
    workingMemory: string;
  }> {
    const memory = await this.ensureMemory();
    await this.ensureThreadExists(input);

    const memoryConfig = this.buildMemoryConfig(await this.getCharacter());
    const recalled = await memory.recall({
      threadId: input.threadId,
      resourceId: input.resourceId,
      perPage: false,
      threadConfig: memoryConfig
    });

    const workingMemory =
      (await memory.getWorkingMemory({
        threadId: input.threadId,
        resourceId: input.resourceId,
        memoryConfig
      })) ?? this.resolveWorkingMemoryTemplate(await this.getCharacter());

    return {
      messages: recalled.messages,
      workingMemory
    };
  }

  async getWorkingMemory(input: MemoryResourceContext): Promise<WorkingMemoryDocument> {
    const memory = await this.ensureMemory();
    await this.ensureThreadExists(input);
    const memoryConfig = this.buildMemoryConfig(await this.getCharacter());

    const markdown =
      (await memory.getWorkingMemory({
        threadId: input.threadId,
        resourceId: input.resourceId,
        memoryConfig
      })) ?? this.resolveWorkingMemoryTemplate(await this.getCharacter());

    return {
      markdown,
      updatedAt: new Date().toISOString()
    };
  }

  async saveWorkingMemory(
    input: MemoryResourceContext & {
      markdown: string;
    }
  ): Promise<WorkingMemoryDocument> {
    const memory = await this.ensureMemory();
    await this.ensureThreadExists(input);
    const memoryConfig = this.buildMemoryConfig(await this.getCharacter());

    await memory.updateWorkingMemory({
      threadId: input.threadId,
      resourceId: input.resourceId,
      workingMemory: input.markdown,
      memoryConfig
    });

    return {
      markdown: input.markdown,
      updatedAt: new Date().toISOString()
    };
  }

  async addTopic(input: {
    text: string;
    source: string;
    expiresAt?: string | null;
    material?: BrowseTopicMaterial;
  }): Promise<boolean> {
    const client = await this.ensureTopicClient();
    const text = normalizeTopicText(input.text);
    if (!text) {
      return false;
    }

    await this.cleanup();
    const now = new Date().toISOString();
    const normalizedText = text.toLowerCase();
    const activeCountResult = await client.execute({
      sql: `SELECT COUNT(*) AS total
            FROM pending_topics
            WHERE used = 0
              AND (expires_at IS NULL OR expires_at > ?)`,
      args: [now]
    });
    const activeCount = parseSqlCount(activeCountResult.rows[0]?.total);
    if (activeCount >= 10) {
      return false;
    }

    const existing = await client.execute({
      sql: `SELECT id
            FROM pending_topics
            WHERE normalized_text = ?
              AND (used = 1 OR expires_at IS NULL OR expires_at > ?)
            LIMIT 1`,
      args: [normalizedText, now]
    });

    if (existing.rows.length > 0) {
      return false;
    }

    const expiresAt = input.expiresAt ? input.expiresAt : null;
    const material = normalizeBrowseTopicMaterial(input.material);
    await client.execute({
      sql: `INSERT INTO pending_topics (id, text, normalized_text, source, created_at, expires_at, used, material_json)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      args: [
        randomUUID(),
        text,
        normalizedText,
        input.source,
        now,
        expiresAt,
        material ? JSON.stringify(material) : null
      ]
    });
    return true;
  }

  async listActive(limit = 3): Promise<PendingTopic[]> {
    const client = await this.ensureTopicClient();
    await this.cleanup();

    const now = new Date().toISOString();
    const safeLimit = Math.max(1, Math.min(20, limit));
    const result = await client.execute({
      sql: `SELECT id, text, source, created_at, expires_at, material_json
            FROM pending_topics
            WHERE used = 0
              AND (expires_at IS NULL OR expires_at > ?)
            ORDER BY created_at DESC
            LIMIT ?`,
      args: [now, safeLimit]
    });

    return result.rows
      .map((row): PendingTopic | null => {
        const id = typeof row.id === "string" ? row.id : "";
        const text = typeof row.text === "string" ? row.text : "";
        const source = typeof row.source === "string" ? row.source : "";
        const createdAt = typeof row.created_at === "string" ? row.created_at : "";
        const rawExpiresAt = row.expires_at;
        const expiresAt = typeof rawExpiresAt === "string" && rawExpiresAt ? rawExpiresAt : null;
        const materialRaw = typeof row.material_json === "string" ? row.material_json : "";
        let material: BrowseTopicMaterial | undefined;
        if (materialRaw) {
          try {
            material = normalizeBrowseTopicMaterial(JSON.parse(materialRaw));
          } catch {
            material = undefined;
          }
        }
        if (!id || !text || !source || !createdAt) {
          return null;
        }

        const topic: PendingTopic = {
          id,
          text,
          source,
          createdAt,
          expiresAt,
          used: false
        };
        if (material) {
          topic.material = material;
        }
        return topic;
      })
      .filter((item): item is PendingTopic => item !== null);
  }

  async listTopicPool(limit = 20): Promise<TopicPoolItem[]> {
    const client = await this.ensureTopicClient();
    await this.cleanup();
    const now = new Date().toISOString();
    const safeLimit = Math.max(1, Math.min(100, limit));
    const result = await client.execute({
      sql: `SELECT id, text, source, created_at, expires_at, used, material_json
            FROM pending_topics
            WHERE used = 1
               OR expires_at IS NULL
               OR expires_at > ?
            ORDER BY created_at DESC
            LIMIT ?`,
      args: [now, safeLimit]
    });

    return result.rows
      .map((row): TopicPoolItem | null => {
        const id = typeof row.id === "string" ? row.id : "";
        const text = typeof row.text === "string" ? row.text : "";
        const source = typeof row.source === "string" ? row.source : "";
        const createdAt = typeof row.created_at === "string" ? row.created_at : "";
        const rawExpiresAt = row.expires_at;
        const expiresAt = typeof rawExpiresAt === "string" && rawExpiresAt ? rawExpiresAt : null;
        const rawUsed = row.used;
        const used = rawUsed === 1 || rawUsed === "1";
        const materialRaw = typeof row.material_json === "string" ? row.material_json : "";
        let material: BrowseTopicMaterial | undefined;
        if (materialRaw) {
          try {
            material = normalizeBrowseTopicMaterial(JSON.parse(materialRaw));
          } catch {
            material = undefined;
          }
        }
        if (!id || !text || !source || !createdAt) {
          return null;
        }

        const topic: TopicPoolItem = {
          id,
          text,
          source,
          createdAt,
          expiresAt,
          used
        };
        if (material) {
          topic.material = material;
        }
        return topic;
      })
      .filter((item): item is TopicPoolItem => item !== null);
  }

  async deleteTopic(topicId: string): Promise<boolean> {
    const client = await this.ensureTopicClient();
    const id = topicId.trim();
    if (!id) {
      return false;
    }

    const existing = await client.execute({
      sql: `SELECT id
            FROM pending_topics
            WHERE id = ?
            LIMIT 1`,
      args: [id]
    });
    if (existing.rows.length === 0) {
      return false;
    }

    await client.execute({
      sql: `DELETE FROM pending_topics
            WHERE id = ?`,
      args: [id]
    });
    return true;
  }

  async clearTopicPool(): Promise<number> {
    const client = await this.ensureTopicClient();
    const countResult = await client.execute({
      sql: `SELECT COUNT(*) AS total
            FROM pending_topics`
    });
    const total = parseSqlCount(countResult.rows[0]?.total);
    if (total <= 0) {
      return 0;
    }

    await client.execute({
      sql: `DELETE FROM pending_topics`
    });
    return total;
  }

  async markUsed(topicId: string): Promise<void> {
    const client = await this.ensureTopicClient();
    const id = topicId.trim();
    if (!id) {
      return;
    }

    await client.execute({
      sql: `UPDATE pending_topics
            SET used = 1,
                used_at = ?
            WHERE id = ?`,
      args: [new Date().toISOString(), id]
    });
  }

  async countUnusedTopics(): Promise<number> {
    const client = await this.ensureTopicClient();
    await this.cleanup();
    const now = new Date().toISOString();
    const result = await client.execute({
      sql: `SELECT COUNT(*) AS total
            FROM pending_topics
            WHERE used = 0
              AND (expires_at IS NULL OR expires_at > ?)`,
      args: [now]
    });

    return parseSqlCount(result.rows[0]?.total);
  }

  async cleanup(): Promise<void> {
    const client = await this.ensureTopicClient();
    const now = new Date().toISOString();
    const usedRetentionCutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    await client.execute({
      sql: `DELETE FROM pending_topics
            WHERE (used = 0 AND expires_at IS NOT NULL AND expires_at <= ?)
               OR (used = 1 AND COALESCE(used_at, created_at) <= ?)`,
      args: [now, usedRetentionCutoff]
    });
  }

  async getInterestProfile(): Promise<InterestProfile> {
    const client = await this.ensureTopicClient();
    const result = await client.execute({
      sql: `SELECT payload_json, updated_at
            FROM interest_profile
            WHERE id = ?
            LIMIT 1`,
      args: [INTEREST_PROFILE_ID]
    });

    if (result.rows.length === 0) {
      return {
        ...EMPTY_INTEREST_PROFILE
      };
    }

    const row = result.rows[0];
    const payloadRaw = typeof row.payload_json === "string" ? row.payload_json : "";
    const updatedAtRaw = typeof row.updated_at === "string" ? row.updated_at : undefined;

    try {
      const parsed = normalizeInterestProfile(payloadRaw ? JSON.parse(payloadRaw) : null);
      return {
        ...parsed,
        updatedAt:
          updatedAtRaw && Number.isFinite(new Date(updatedAtRaw).getTime())
            ? new Date(updatedAtRaw).toISOString()
            : parsed.updatedAt
      };
    } catch {
      return {
        ...EMPTY_INTEREST_PROFILE
      };
    }
  }

  async saveInterestProfile(input: InterestProfile): Promise<InterestProfile> {
    const client = await this.ensureTopicClient();
    const normalized = normalizeInterestProfile(input);
    const updatedAt = new Date().toISOString();
    const payload = {
      games: normalized.games,
      creators: normalized.creators,
      domains: normalized.domains,
      dislikes: normalized.dislikes,
      keywords: normalized.keywords,
      updatedAt
    };

    await client.execute({
      sql: `INSERT INTO interest_profile (id, payload_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              payload_json = excluded.payload_json,
              updated_at = excluded.updated_at`,
      args: [INTEREST_PROFILE_ID, JSON.stringify(payload), updatedAt]
    });

    return {
      ...payload
    };
  }

  async listHistory(input: ListHistoryInput): Promise<HistoryMessage[]> {
    const raw = await this.listThreadMessages(input);
    const mapped = raw
      .map((message) => toHistoryMessage(message))
      .filter((message): message is HistoryMessage => message !== null);

    const query = input.query?.trim().toLowerCase();
    const filtered = query
      ? mapped.filter((item) => item.text.toLowerCase().includes(query))
      : mapped;

    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.max(1, Math.min(200, input.limit ?? 100));
    return filtered.slice(offset, offset + limit);
  }

  async listHistoryByCursor(input: CursorHistoryInput): Promise<{
    items: HistoryMessage[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    const limit = Math.max(1, Math.min(100, input.limit ?? 20));
    const raw = await this.listThreadMessages(input);
    const mapped = raw
      .map((message) => toHistoryMessage(message))
      .filter((message): message is HistoryMessage => message !== null)
      .filter((message) => message.role === "user" || message.role === "assistant");

    let base = mapped;
    if (input.beforeId) {
      const index = mapped.findIndex((item) => item.id === input.beforeId);
      base = index >= 0 ? mapped.slice(0, index) : mapped;
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

  async countHistory(input: MemoryResourceContext): Promise<number> {
    const raw = await this.listThreadMessages(input);
    return raw
      .map((message) => toHistoryMessage(message))
      .filter((message): message is HistoryMessage => message !== null).length;
  }

  async clearThread(input: MemoryResourceContext): Promise<void> {
    const memory = await this.ensureMemory();
    const thread = await memory.getThreadById({
      threadId: input.threadId
    });

    if (thread) {
      await memory.deleteThread(input.threadId);
    }

    await memory.createThread({
      threadId: input.threadId,
      resourceId: input.resourceId,
      saveThread: true,
      title: "Main Thread"
    });
  }

  async mapRecentToModelMessages(input: MemoryResourceContext): Promise<Array<{ role: "system" | "user" | "assistant"; content: string }>> {
    const config = this.getConfig();
    const recalled = await this.recall(input);
    const max = Math.max(10, config.memory.recentMessages);

    return recalled.messages
      .map((message) => {
        const role = normalizeRole(message.role);
        const content = extractTextFromMessage(message);
        if (!content) {
          return null;
        }

        return {
          role,
          content
        };
      })
      .filter((message): message is { role: "system" | "user" | "assistant"; content: string } => message !== null)
      .slice(-max);
  }

  async updateWorkingMemoryFromSummary(input: MemoryResourceContext & {
    markdown: string;
  }): Promise<void> {
    const memory = await this.ensureMemory();
    const memoryConfig = this.buildMemoryConfig(await this.getCharacter());
    await memory.updateWorkingMemory({
      threadId: input.threadId,
      resourceId: input.resourceId,
      workingMemory: input.markdown,
      memoryConfig
    });
  }

  private async listThreadMessages(input: MemoryResourceContext): Promise<MastraDBMessage[]> {
    const memory = await this.ensureMemory();
    await this.ensureThreadExists(input);

    const recalled = await memory.recall({
      threadId: input.threadId,
      resourceId: input.resourceId,
      perPage: false,
      threadConfig: this.buildMemoryConfig(await this.getCharacter())
    });

    return recalled.messages;
  }

  private async ensureThreadExists(input: MemoryResourceContext): Promise<void> {
    const memory = await this.ensureMemory();
    const thread = await memory.getThreadById({
      threadId: input.threadId
    });

    if (thread) {
      return;
    }

    await memory.createThread({
      threadId: input.threadId,
      resourceId: input.resourceId,
      saveThread: true,
      title: "Main Thread"
    });
  }

  private async ensureMemory(): Promise<Memory> {
    const character = await this.getCharacter();
    const config = this.getConfig();
    const nextKey = JSON.stringify({
      dbPath: this.paths.yobiDbPath,
      memory: config.memory,
      providers: config.providers,
      template: this.resolveWorkingMemoryTemplate(character)
    });

    if (this.memory && this.storage && this.memoryKey === nextKey) {
      return this.memory;
    }

    this.storage = new LibSQLStore({
      id: "yobi-storage",
      url: `file:${this.paths.yobiDbPath}`
    });
    this.memory = new Memory({
      storage: this.storage,
      options: this.buildMemoryConfig(character)
    });
    this.memoryKey = nextKey;
    return this.memory;
  }

  private async ensureTopicClient(): Promise<LibsqlClient> {
    if (!this.topicClient) {
      this.topicClient = createClient({
        url: `file:${this.paths.yobiDbPath}`
      });
    }

    if (this.topicTableReady) {
      return this.topicClient;
    }

    await this.topicClient.executeMultiple(`
      CREATE TABLE IF NOT EXISTS pending_topics (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        used INTEGER NOT NULL DEFAULT 0,
        used_at TEXT,
        material_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pending_topics_active
        ON pending_topics (used, expires_at, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pending_topics_normalized
        ON pending_topics (normalized_text, used, expires_at);
      CREATE TABLE IF NOT EXISTS interest_profile (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const tableInfo = await this.topicClient.execute("PRAGMA table_info(pending_topics)");
    const hasUsedAt = tableInfo.rows.some((row) => row.name === "used_at");
    if (!hasUsedAt) {
      await this.topicClient.execute("ALTER TABLE pending_topics ADD COLUMN used_at TEXT");
    }
    const hasMaterialJson = tableInfo.rows.some((row) => row.name === "material_json");
    if (!hasMaterialJson) {
      await this.topicClient.execute("ALTER TABLE pending_topics ADD COLUMN material_json TEXT");
    }

    this.topicTableReady = true;
    return this.topicClient;
  }

  private buildMemoryConfig(character: CharacterProfile): MemoryConfig {
    const config = this.getConfig();
    const observationalModel = this.resolveObservationalModel(config);
    const hasOM = config.memory.observational.enabled && observationalModel !== null;

    return {
      lastMessages: hasOM ? Math.min(20, config.memory.recentMessages) : config.memory.recentMessages,
      semanticRecall: false,
      workingMemory: {
        enabled: true,
        scope: "resource",
        template: this.resolveWorkingMemoryTemplate(character)
      },
      observationalMemory: hasOM
        ? {
            model: observationalModel
          }
        : false
    };
  }

  private resolveObservationalModel(config: AppConfig): any | null {
    const model = config.memory.observational.model.trim();
    const providerId = config.memory.observational.providerId.trim();
    if (!model || !providerId) {
      return null;
    }

    const provider = config.providers.find((item) => item.id === providerId);
    if (!provider || !provider.enabled) {
      return null;
    }

    try {
      return createModelForProvider(provider, model);
    } catch (error) {
      console.warn("[memory] observational model disabled:", error);
      return null;
    }
  }

  private resolveWorkingMemoryTemplate(character: CharacterProfile): string {
    return character.workingMemoryTemplate?.trim() || DEFAULT_WORKING_MEMORY_TEMPLATE;
  }
}
