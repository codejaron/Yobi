import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import type { HistoryMessage } from "@shared/types";
import { CompanionPaths } from "./paths";

interface SearchOptions {
  limit?: number;
  offset?: number;
  query?: string;
}

interface CursorSearchOptions {
  limit?: number;
  beforeId?: string;
  query?: string;
  channel?: HistoryMessage["channel"];
  roles?: HistoryMessage["role"][];
}

interface CursorSearchResult {
  items: HistoryMessage[];
  hasMore: boolean;
  nextCursor: string | null;
}

function parseJsonl(content: string): HistoryMessage[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as HistoryMessage;
      } catch {
        return null;
      }
    })
    .filter((item): item is HistoryMessage => item !== null);
}

export class HistoryStore {
  constructor(private readonly paths: CompanionPaths) {}

  async append(
    role: HistoryMessage["role"],
    text: string,
    channel: HistoryMessage["channel"],
    meta?: HistoryMessage["meta"]
  ): Promise<HistoryMessage> {
    const message: HistoryMessage = {
      id: randomUUID(),
      role,
      text,
      channel,
      timestamp: new Date().toISOString(),
      meta
    };

    await fs.appendFile(this.paths.historyPath, `${JSON.stringify(message)}\n`, "utf8");
    return message;
  }

  async getRecent(limit = 30): Promise<HistoryMessage[]> {
    const content = await fs.readFile(this.paths.historyPath, "utf8").catch(() => "");
    const rows = parseJsonl(content);
    return rows.slice(Math.max(0, rows.length - limit));
  }

  async search(options: SearchOptions = {}): Promise<HistoryMessage[]> {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const query = options.query?.trim().toLowerCase();

    const content = await fs.readFile(this.paths.historyPath, "utf8").catch(() => "");
    let rows = parseJsonl(content);

    if (query) {
      rows = rows.filter((item) => item.text.toLowerCase().includes(query));
    }

    return rows.slice(offset, offset + limit);
  }

  async searchByCursor(options: CursorSearchOptions = {}): Promise<CursorSearchResult> {
    const limit = Math.max(1, Math.min(100, Math.round(options.limit ?? 20)));
    const query = options.query?.trim().toLowerCase();
    const beforeId = options.beforeId?.trim();
    const channel = options.channel;
    const roles = Array.isArray(options.roles) ? options.roles : [];

    const content = await fs.readFile(this.paths.historyPath, "utf8").catch(() => "");
    let rows = parseJsonl(content);

    if (channel) {
      rows = rows.filter((item) => item.channel === channel);
    }

    if (roles.length > 0) {
      const allowed = new Set(roles);
      rows = rows.filter((item) => allowed.has(item.role));
    }

    if (query) {
      rows = rows.filter((item) => item.text.toLowerCase().includes(query));
    }

    let baseRows = rows;
    if (beforeId) {
      const boundaryIndex = rows.findIndex((item) => item.id === beforeId);
      if (boundaryIndex > 0) {
        baseRows = rows.slice(0, boundaryIndex);
      } else if (boundaryIndex === 0) {
        baseRows = [];
      }
    }

    if (baseRows.length === 0) {
      return {
        items: [],
        hasMore: false,
        nextCursor: null
      };
    }

    const startIndex = Math.max(0, baseRows.length - limit);
    const items = baseRows.slice(startIndex);
    const hasMore = startIndex > 0;
    const nextCursor = hasMore ? items[0]?.id ?? null : null;

    return {
      items,
      hasMore,
      nextCursor
    };
  }

  async count(): Promise<number> {
    const content = await fs.readFile(this.paths.historyPath, "utf8").catch(() => "");
    return parseJsonl(content).length;
  }
}
