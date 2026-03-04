export type KernelEventPriority = "P0" | "P1" | "P2" | "P3";

export interface KernelEvent {
  id: string;
  type: string;
  priority: KernelEventPriority;
  createdAt: string;
  payload?: Record<string, unknown>;
}

const PRIORITY_ORDER: KernelEventPriority[] = ["P0", "P1", "P2", "P3"];

export class KernelEventQueue {
  private readonly buckets = new Map<KernelEventPriority, KernelEvent[]>(
    PRIORITY_ORDER.map((priority) => [priority, []])
  );

  enqueue(event: Omit<KernelEvent, "createdAt"> & { createdAt?: string }): KernelEvent {
    const normalized: KernelEvent = {
      ...event,
      createdAt: event.createdAt ?? new Date().toISOString()
    };
    const target = this.buckets.get(normalized.priority);
    if (target) {
      target.push(normalized);
    }
    return normalized;
  }

  dequeue(): KernelEvent | null {
    for (const priority of PRIORITY_ORDER) {
      const target = this.buckets.get(priority);
      if (!target || target.length === 0) {
        continue;
      }
      return target.shift() ?? null;
    }
    return null;
  }

  drain(max = Number.MAX_SAFE_INTEGER): KernelEvent[] {
    const events: KernelEvent[] = [];
    while (events.length < max) {
      const next = this.dequeue();
      if (!next) {
        break;
      }
      events.push(next);
    }
    return events;
  }

  size(): number {
    let total = 0;
    for (const priority of PRIORITY_ORDER) {
      const bucket = this.buckets.get(priority);
      total += bucket?.length ?? 0;
    }
    return total;
  }

  clear(): void {
    for (const priority of PRIORITY_ORDER) {
      const bucket = this.buckets.get(priority);
      if (bucket) {
        bucket.length = 0;
      }
    }
  }
}
