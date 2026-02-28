import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import type { Client as LibsqlClient } from "@libsql/client";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import type { MastraDBMessage } from "@mastra/core/agent";
import type { MemoryConfig } from "@mastra/core/memory";
import type {
  AppConfig,
  CharacterProfile,
  HistoryMessage,
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

export interface PendingTopic {
  id: string;
  text: string;
  source: string;
  createdAt: string;
  expiresAt: string | null;
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

function extractTextFromMessage(message: MastraDBMessage): string {
  const rawContent = message.content;
  if (typeof rawContent?.content === "string" && rawContent.content.trim().length > 0) {
    return rawContent.content.trim();
  }

  const textParts = rawContent?.parts
    ?.filter((part) => part?.type === "text" && typeof (part as any).text === "string")
    .map((part) => ((part as any).text as string).trim())
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
  const channel = metadata.channel === "telegram" ? "telegram" : "console";

  return {
    id: message.id,
    role: normalizeRole(message.role),
    text,
    channel,
    timestamp:
      message.createdAt instanceof Date
        ? message.createdAt.toISOString()
        : new Date(message.createdAt).toISOString(),
    meta:
      typeof metadata.proactive === "boolean"
        ? {
            proactive: metadata.proactive
          }
        : undefined
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
  }): Promise<void> {
    const client = await this.ensureTopicClient();
    const text = normalizeTopicText(input.text);
    if (!text) {
      return;
    }

    await this.cleanup();
    const now = new Date().toISOString();
    const normalizedText = text.toLowerCase();
    const existing = await client.execute({
      sql: `SELECT id
            FROM pending_topics
            WHERE normalized_text = ?
              AND used = 0
              AND (expires_at IS NULL OR expires_at > ?)
            LIMIT 1`,
      args: [normalizedText, now]
    });

    if (existing.rows.length > 0) {
      return;
    }

    const expiresAt = input.expiresAt ? input.expiresAt : null;
    await client.execute({
      sql: `INSERT INTO pending_topics (id, text, normalized_text, source, created_at, expires_at, used)
            VALUES (?, ?, ?, ?, ?, ?, 0)`,
      args: [randomUUID(), text, normalizedText, input.source, now, expiresAt]
    });
  }

  async listActive(limit = 3): Promise<PendingTopic[]> {
    const client = await this.ensureTopicClient();
    await this.cleanup();

    const now = new Date().toISOString();
    const safeLimit = Math.max(1, Math.min(20, limit));
    const result = await client.execute({
      sql: `SELECT id, text, source, created_at, expires_at
            FROM pending_topics
            WHERE used = 0
              AND (expires_at IS NULL OR expires_at > ?)
            ORDER BY created_at DESC
            LIMIT ?`,
      args: [now, safeLimit]
    });

    return result.rows
      .map((row) => {
        const id = typeof row.id === "string" ? row.id : "";
        const text = typeof row.text === "string" ? row.text : "";
        const source = typeof row.source === "string" ? row.source : "";
        const createdAt = typeof row.created_at === "string" ? row.created_at : "";
        const rawExpiresAt = row.expires_at;
        const expiresAt = typeof rawExpiresAt === "string" && rawExpiresAt ? rawExpiresAt : null;
        if (!id || !text || !source || !createdAt) {
          return null;
        }

        return {
          id,
          text,
          source,
          createdAt,
          expiresAt
        };
      })
      .filter((item): item is PendingTopic => item !== null);
  }

  async markUsed(topicId: string): Promise<void> {
    const client = await this.ensureTopicClient();
    const id = topicId.trim();
    if (!id) {
      return;
    }

    await client.execute({
      sql: `UPDATE pending_topics
            SET used = 1
            WHERE id = ?`,
      args: [id]
    });
  }

  async cleanup(): Promise<void> {
    const client = await this.ensureTopicClient();
    const now = new Date().toISOString();
    await client.execute({
      sql: `DELETE FROM pending_topics
            WHERE used = 1
               OR (expires_at IS NOT NULL AND expires_at <= ?)`,
      args: [now]
    });
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
        used INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_pending_topics_active
        ON pending_topics (used, expires_at, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pending_topics_normalized
        ON pending_topics (normalized_text, used, expires_at);
    `);

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
