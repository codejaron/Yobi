import { randomUUID } from "node:crypto";
import type { ReminderItem } from "@shared/types";
import { DEFAULT_REMINDERS } from "@shared/types";
import { CompanionPaths } from "./paths";
import { fileExists, readJsonFile, writeJsonFile } from "./fs";

interface ReminderStoreDocument {
  items: ReminderItem[];
}

export class ReminderStore {
  private cached: ReminderStoreDocument = DEFAULT_REMINDERS;

  constructor(private readonly paths: CompanionPaths) {}

  async init(): Promise<void> {
    const exists = await fileExists(this.paths.remindersPath);
    if (!exists) {
      this.cached = DEFAULT_REMINDERS;
      await writeJsonFile(this.paths.remindersPath, this.cached);
      return;
    }

    const raw = await readJsonFile<ReminderStoreDocument>(this.paths.remindersPath, DEFAULT_REMINDERS);
    this.cached = {
      items: Array.isArray(raw.items)
        ? raw.items.filter((item) => {
            const parsedAt = Date.parse(item.at);
            const parsedCreated = Date.parse(item.createdAt);
            return Boolean(item.id && item.text && Number.isFinite(parsedAt) && Number.isFinite(parsedCreated));
          })
        : []
    };
    await this.persist();
  }

  list(): ReminderItem[] {
    return [...this.cached.items].sort((a, b) => (a.at > b.at ? 1 : -1));
  }

  async add(input: { text: string; at: string; sourceMessageId?: string }): Promise<ReminderItem> {
    const item: ReminderItem = {
      id: randomUUID(),
      text: input.text.trim(),
      at: new Date(input.at).toISOString(),
      createdAt: new Date().toISOString(),
      sourceMessageId: input.sourceMessageId
    };

    this.cached = {
      items: [...this.cached.items, item]
    };
    await this.persist();
    return item;
  }

  async remove(id: string): Promise<ReminderItem | null> {
    const target = this.cached.items.find((item) => item.id === id) ?? null;
    if (!target) {
      return null;
    }

    this.cached = {
      items: this.cached.items.filter((item) => item.id !== id)
    };
    await this.persist();
    return target;
  }

  async removeMany(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    const idSet = new Set(ids);
    this.cached = {
      items: this.cached.items.filter((item) => !idSet.has(item.id))
    };
    await this.persist();
  }

  async persist(): Promise<void> {
    await writeJsonFile(this.paths.remindersPath, this.cached);
  }
}
