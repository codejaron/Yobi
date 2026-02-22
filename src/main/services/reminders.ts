import type { ReminderItem } from "@shared/types";
import { ReminderStore } from "@main/storage/reminder-store";

interface ReminderDispatcher {
  sendReminder(item: ReminderItem): Promise<void>;
}

export class ReminderService {
  private jobs = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly store: ReminderStore,
    private readonly dispatcher: ReminderDispatcher
  ) {}

  async init(): Promise<void> {
    for (const item of this.store.list()) {
      this.schedule(item);
    }

    await this.cleanupExpired();
  }

  list(): ReminderItem[] {
    return this.store.list();
  }

  count(): number {
    return this.store.list().length;
  }

  async create(input: { text: string; at: string; sourceMessageId?: string }): Promise<ReminderItem | null> {
    const when = new Date(input.at);
    if (Number.isNaN(when.getTime())) {
      return null;
    }

    const item = await this.store.add({
      text: input.text,
      at: when.toISOString(),
      sourceMessageId: input.sourceMessageId
    });

    this.schedule(item);
    return item;
  }

  async cancel(id: string): Promise<ReminderItem | null> {
    const timer = this.jobs.get(id);
    if (timer) {
      clearTimeout(timer);
    }
    this.jobs.delete(id);
    return this.store.remove(id);
  }

  async createBatch(inputs: Array<{ text: string; at: string; sourceMessageId?: string }>): Promise<ReminderItem[]> {
    const created: ReminderItem[] = [];
    for (const input of inputs) {
      const item = await this.create(input);
      if (item) {
        created.push(item);
      }
    }
    return created;
  }

  private schedule(item: ReminderItem): void {
    const runAt = new Date(item.at);
    if (Number.isNaN(runAt.getTime()) || runAt.getTime() <= Date.now()) {
      return;
    }

    const existing = this.jobs.get(item.id);
    if (existing) {
      clearTimeout(existing);
    }

    const delayMs = runAt.getTime() - Date.now();
    const timer = setTimeout(() => {
      void this.fire(item.id);
    }, delayMs);

    this.jobs.set(item.id, timer);
  }

  private async fire(id: string): Promise<void> {
    const item = this.store.list().find((candidate) => candidate.id === id);
    if (!item) {
      this.jobs.delete(id);
      return;
    }

    await this.dispatcher.sendReminder(item);
    await this.store.remove(id);
    const timer = this.jobs.get(id);
    if (timer) {
      clearTimeout(timer);
    }
    this.jobs.delete(id);
  }

  private async cleanupExpired(): Promise<void> {
    const expired = this.store
      .list()
      .filter((item) => new Date(item.at).getTime() <= Date.now())
      .map((item) => item.id);

    await this.store.removeMany(expired);
  }
}
