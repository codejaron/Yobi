import { randomUUID } from "node:crypto";
import type { BrowseTopicMaterial, InterestProfile, TopicPoolItem } from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import { readJsonFile, writeJsonFileAtomic } from "@main/storage/fs";

interface TopicPoolDocument {
  items: TopicPoolItem[];
}

const EMPTY_POOL: TopicPoolDocument = {
  items: []
};

const EMPTY_PROFILE: InterestProfile = {
  games: [],
  creators: [],
  domains: [],
  dislikes: [],
  keywords: [],
  updatedAt: new Date(0).toISOString()
};

export class TopicStore {
  private loaded = false;
  private pool: TopicPoolDocument = {
    ...EMPTY_POOL
  };
  private profile: InterestProfile = {
    ...EMPTY_PROFILE
  };

  constructor(private readonly paths: CompanionPaths) {}

  async init(): Promise<void> {
    if (this.loaded) {
      return;
    }
    const poolRaw = await readJsonFile<TopicPoolDocument>(this.paths.topicPoolPath, EMPTY_POOL);
    this.pool = {
      items: Array.isArray(poolRaw.items)
        ? poolRaw.items
            .map((item) => normalizeTopic(item))
            .filter((item): item is TopicPoolItem => item !== null)
        : []
    };
    this.profile = normalizeInterest(await readJsonFile(this.paths.topicInterestProfilePath, EMPTY_PROFILE));
    this.loaded = true;
  }

  async addTopic(input: {
    text: string;
    source: string;
    expiresAt?: string | null;
    material?: BrowseTopicMaterial;
  }): Promise<boolean> {
    await this.init();
    const text = normalizeText(input.text);
    if (!text) {
      return false;
    }
    const now = Date.now();
    const active = this.pool.items.filter((item) => !item.used && !isExpired(item, now));
    if (active.length >= 10) {
      return false;
    }

    const duplicate = active.some((item) => item.text.toLowerCase() === text.toLowerCase());
    if (duplicate) {
      return false;
    }

    this.pool.items.push({
      id: randomUUID(),
      text,
      source: input.source,
      createdAt: new Date().toISOString(),
      expiresAt: normalizeTimestamp(input.expiresAt),
      used: false,
      material: input.material
    });
    await this.persistPool();
    return true;
  }

  async listActive(limit = 3): Promise<TopicPoolItem[]> {
    await this.init();
    const now = Date.now();
    return this.pool.items
      .filter((item) => !item.used && !isExpired(item, now))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, Math.max(1, limit))
      .map((item) => ({ ...item }));
  }

  async listTopicPool(limit = 50): Promise<TopicPoolItem[]> {
    await this.init();
    const now = Date.now();
    return this.pool.items
      .filter((item) => !isExpired(item, now) || item.used)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, Math.max(1, limit))
      .map((item) => ({ ...item }));
  }

  async clearTopicPool(): Promise<number> {
    await this.init();
    const count = this.pool.items.length;
    this.pool.items = [];
    await this.persistPool();
    return count;
  }

  async clearBySourcePrefixes(prefixes: string[]): Promise<number> {
    await this.init();
    const normalized = prefixes.map((item) => item.trim()).filter(Boolean);
    if (normalized.length === 0) {
      return 0;
    }
    const next = this.pool.items.filter(
      (item) => !normalized.some((prefix) => item.source === prefix || item.source.startsWith(prefix))
    );
    const removed = this.pool.items.length - next.length;
    if (removed <= 0) {
      return 0;
    }
    this.pool.items = next;
    await this.persistPool();
    return removed;
  }

  async deleteTopic(id: string): Promise<boolean> {
    await this.init();
    const next = this.pool.items.filter((item) => item.id !== id);
    const removed = next.length !== this.pool.items.length;
    if (!removed) {
      return false;
    }
    this.pool.items = next;
    await this.persistPool();
    return true;
  }

  async markUsed(id: string): Promise<void> {
    await this.init();
    let changed = false;
    for (const item of this.pool.items) {
      if (item.id !== id) {
        continue;
      }
      item.used = true;
      changed = true;
      break;
    }
    if (changed) {
      await this.persistPool();
    }
  }

  async countUnusedTopics(): Promise<number> {
    await this.init();
    const now = Date.now();
    return this.pool.items.filter((item) => !item.used && !isExpired(item, now)).length;
  }

  async cleanup(): Promise<void> {
    await this.init();
    const now = Date.now();
    const cutoff = now - 3 * 24 * 3600 * 1000;
    const next = this.pool.items.filter((item) => {
      if (!item.used && isExpired(item, now)) {
        return false;
      }
      if (item.used) {
        const usedAt = new Date(item.createdAt).getTime();
        if (Number.isFinite(usedAt) && usedAt < cutoff) {
          return false;
        }
      }
      return true;
    });
    if (next.length !== this.pool.items.length) {
      this.pool.items = next;
      await this.persistPool();
    }
  }

  async getInterestProfile(): Promise<InterestProfile> {
    await this.init();
    return {
      ...this.profile,
      games: [...this.profile.games],
      creators: [...this.profile.creators],
      domains: [...this.profile.domains],
      dislikes: [...this.profile.dislikes],
      keywords: [...this.profile.keywords]
    };
  }

  async saveInterestProfile(input: InterestProfile): Promise<InterestProfile> {
    await this.init();
    this.profile = normalizeInterest(input);
    this.profile.updatedAt = new Date().toISOString();
    await writeJsonFileAtomic(this.paths.topicInterestProfilePath, this.profile);
    return this.getInterestProfile();
  }

  private async persistPool(): Promise<void> {
    await writeJsonFileAtomic(this.paths.topicPoolPath, this.pool);
  }
}

function normalizeTopic(input: TopicPoolItem): TopicPoolItem | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const id = typeof input.id === "string" && input.id ? input.id : randomUUID();
  const text = normalizeText(input.text);
  const source = typeof input.source === "string" ? input.source : "unknown";
  if (!text) {
    return null;
  }
  return {
    id,
    text,
    source,
    createdAt: normalizeTimestamp(input.createdAt) ?? new Date().toISOString(),
    expiresAt: normalizeTimestamp(input.expiresAt),
    used: Boolean(input.used),
    material: input.material
  };
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

function normalizeText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, " ").trim();
}

function isExpired(topic: TopicPoolItem, nowMs: number): boolean {
  if (!topic.expiresAt) {
    return false;
  }
  const expires = new Date(topic.expiresAt).getTime();
  if (!Number.isFinite(expires)) {
    return false;
  }
  return expires <= nowMs;
}

function normalizeInterest(input: InterestProfile): InterestProfile {
  const fallback = {
    ...EMPTY_PROFILE
  };
  return {
    games: normalizeList(input?.games),
    creators: normalizeList(input?.creators),
    domains: normalizeList(input?.domains),
    dislikes: normalizeList(input?.dislikes),
    keywords: normalizeList(input?.keywords),
    updatedAt:
      typeof input?.updatedAt === "string" && Number.isFinite(new Date(input.updatedAt).getTime())
        ? new Date(input.updatedAt).toISOString()
        : fallback.updatedAt
  };
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, 100);
}
