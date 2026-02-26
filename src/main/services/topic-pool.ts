import { randomUUID } from "node:crypto";
import { fileExists, readJsonFile, writeJsonFile } from "@main/storage/fs";

export interface PendingTopic {
  id: string;
  text: string;
  source: "recall" | "wander";
  createdAt: string;
  expiresAt: string | null;
  used: boolean;
}

interface TopicDocument {
  topics: PendingTopic[];
}

const MAX_TOPICS = 120;

function createDefaultDoc(): TopicDocument {
  return {
    topics: []
  };
}

function topicStillActive(topic: PendingTopic, now = Date.now()): boolean {
  if (topic.used) {
    return false;
  }

  if (!topic.expiresAt) {
    return true;
  }

  const expiresAt = new Date(topic.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export class TopicPool {
  private cached: TopicDocument = createDefaultDoc();

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    const exists = await fileExists(this.filePath);
    if (!exists) {
      this.cached = createDefaultDoc();
      await writeJsonFile(this.filePath, this.cached);
      return;
    }

    this.cached = await readJsonFile<TopicDocument>(this.filePath, createDefaultDoc());
    await this.cleanup();
  }

  async add(input: {
    text: string;
    source: PendingTopic["source"];
    expiresAt?: string | null;
  }): Promise<void> {
    const text = input.text.trim();
    if (!text) {
      return;
    }

    const normalized = text.toLowerCase();
    const existing = this.cached.topics.find((topic) =>
      topicStillActive(topic) && topic.text.trim().toLowerCase() === normalized
    );

    if (existing) {
      if (input.expiresAt !== undefined) {
        existing.expiresAt = input.expiresAt;
      }
      await this.persist();
      return;
    }

    this.cached.topics.push({
      id: randomUUID(),
      text,
      source: input.source,
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt ?? null,
      used: false
    });

    if (this.cached.topics.length > MAX_TOPICS) {
      this.cached.topics = this.cached.topics.slice(-MAX_TOPICS);
    }

    await this.persist();
  }

  peek(limit = 3): PendingTopic[] {
    const now = Date.now();
    return this.cached.topics.filter((topic) => topicStillActive(topic, now)).slice(0, limit);
  }

  listActive(limit?: number): PendingTopic[] {
    const now = Date.now();
    const active = this.cached.topics.filter((topic) => topicStillActive(topic, now));
    if (typeof limit === "number") {
      return active.slice(0, Math.max(0, limit));
    }

    return active;
  }

  async markUsed(id: string): Promise<void> {
    const topic = this.cached.topics.find((item) => item.id === id);
    if (!topic) {
      return;
    }

    topic.used = true;
    await this.persist();
  }

  async cleanup(): Promise<void> {
    const now = Date.now();
    this.cached.topics = this.cached.topics.filter((topic) => topicStillActive(topic, now));
    await this.persist();
  }

  private async persist(): Promise<void> {
    await writeJsonFile(this.filePath, this.cached);
  }
}
