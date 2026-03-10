import type { AppLogger } from "@main/services/logger";
import type { AppConfig } from "@shared/types";
import {
  BILIBILI_SYNC_INTERVAL_MS,
  BILIBILI_SYNC_RETRY_DELAY_MS,
  type BrowseSyncOutcome,
  BilibiliBrowseService
} from "./bilibili-browse-service";

interface BilibiliSyncCoordinatorInput {
  service: BilibiliBrowseService;
  logger: AppLogger;
  getConfig: () => AppConfig;
  onStatusChange: () => Promise<void>;
}

export class BilibiliSyncCoordinator {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private inFlight: Promise<BrowseSyncOutcome> | null = null;

  constructor(private readonly input: BilibiliSyncCoordinatorInput) {}

  async start(): Promise<void> {
    this.started = true;
    await this.refresh();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async refresh(): Promise<void> {
    this.clearTimer();
    const config = this.input.getConfig();
    const cookie = config.browse.bilibiliCookie.trim();
    if (!this.started) {
      return;
    }
    if (!config.browse.enabled || !cookie) {
      await this.input.service.ensureManagedStateMatchesConfig();
      await this.input.onStatusChange();
      return;
    }

    const status = await this.input.service.getStatus();
    const lastSyncAt = status.lastSyncAt ? new Date(status.lastSyncAt).getTime() : 0;
    const overdue = !Number.isFinite(lastSyncAt) || lastSyncAt <= 0 || Date.now() - lastSyncAt >= BILIBILI_SYNC_INTERVAL_MS;
    if (overdue) {
      await this.runAndReschedule();
      return;
    }

    const delayMs = Math.max(1_000, BILIBILI_SYNC_INTERVAL_MS - (Date.now() - lastSyncAt));
    this.schedule(delayMs);
  }

  async triggerNow(): Promise<BrowseSyncOutcome> {
    return this.runAndReschedule();
  }

  private async runAndReschedule(): Promise<BrowseSyncOutcome> {
    const result = await this.runOnce();
    this.scheduleFromOutcome(result);
    return result;
  }

  private async runOnce(): Promise<BrowseSyncOutcome> {
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = (async () => {
      try {
        const result = await this.input.service.runSync();
        return result;
      } catch (error) {
        this.input.logger.warn("browse", "bilibili-sync-runner-failed", undefined, error);
        return {
          ran: true,
          changed: false,
          reason: "error",
          detail: error instanceof Error ? error.message : "unknown",
          nextDelayMs: BILIBILI_SYNC_RETRY_DELAY_MS
        } satisfies BrowseSyncOutcome;
      } finally {
        await this.input.onStatusChange();
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }

  private scheduleFromOutcome(result: BrowseSyncOutcome): void {
    if (!this.started) {
      return;
    }
    const delayMs = result.nextDelayMs;
    if (!Number.isFinite(delayMs) || !delayMs || delayMs <= 0) {
      return;
    }
    this.schedule(delayMs);
  }

  private schedule(delayMs: number): void {
    if (!this.started) {
      return;
    }
    this.clearTimer();
    this.timer = setTimeout(() => {
      void this.runAndReschedule();
    }, Math.max(1_000, delayMs));
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = null;
  }
}
