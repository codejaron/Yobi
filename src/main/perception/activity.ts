import type { ActivitySnapshot, AppConfig } from "@shared/types";
import { ContextStore } from "@main/storage/context-store";
import { LlmRouter } from "@main/core/llm";
import { captureCompressedScreenshot } from "./screen";
import { getActiveWindow, type ActiveWindowInfo } from "./window";

export type ActivityChangeReason = "window-changed" | "summary-changed";

export interface ActivityEvent {
  snapshot: ActivitySnapshot;
  reason: ActivityChangeReason;
}

export class ActivityMonitor {
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<(event: ActivityEvent) => Promise<void> | void>();
  private runningTick = false;
  private latestSnapshot: ActivitySnapshot | null = null;
  private active = false;

  constructor(
    private readonly llm: LlmRouter,
    private readonly contextStore: ContextStore,
    private readonly getConfig: () => AppConfig
  ) {}

  onChange(listener: (event: ActivityEvent) => Promise<void> | void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getCurrentSnapshot(): ActivitySnapshot | null {
    return this.latestSnapshot;
  }

  async start(): Promise<void> {
    if (this.active) {
      return;
    }
    this.active = true;
    await this.tick().catch(() => undefined);

    const interval = this.getConfig().perception.pollIntervalMs;
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, interval);
  }

  stop(): void {
    this.active = false;
    this.latestSnapshot = null;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.active;
  }

  private async tick(): Promise<void> {
    if (this.runningTick) {
      return;
    }

    this.runningTick = true;
    try {
      const windowInfo = await getActiveWindow();
      if (!windowInfo) {
        return;
      }

      const key = `${windowInfo.appId}:${windowInfo.title}`;
      const currentContext = this.contextStore.get();
      if (key === currentContext.lastWindowKey) {
        return;
      }

      const summary = await this.summarizeWindow(windowInfo);

      const reason: ActivityChangeReason =
        summary !== currentContext.lastActivitySummary ? "summary-changed" : "window-changed";

      const snapshot: ActivitySnapshot = {
        app: windowInfo.appName,
        title: windowInfo.title,
        summary,
        changedAt: new Date().toISOString()
      };

      this.latestSnapshot = snapshot;

      await this.contextStore.patch({
        lastWindowKey: key,
        lastActivitySummary: summary
      });

      for (const listener of this.listeners) {
        await listener({ snapshot, reason });
      }
    } finally {
      this.runningTick = false;
    }
  }

  private async summarizeWindow(windowInfo: ActiveWindowInfo): Promise<string> {
    const screenshot = await captureCompressedScreenshot({
      maxWidth: this.getConfig().perception.screenshotMaxWidth,
      quality: this.getConfig().perception.screenshotQuality,
      windowInfo
    });

    if (!screenshot) {
      return `${windowInfo.appName}: ${windowInfo.title}`;
    }

    return this.llm.describeActivity({
      appName: windowInfo.appName,
      windowTitle: windowInfo.title,
      screenshotBase64: screenshot
    });
  }
}
