import type { HeartbeatStats, LoopConfig } from "@shared/cognition";
import { mean } from "../utils/math";

export class PoissonHeartbeat {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private paused = false;
  private nextScheduledTime: number | null = null;
  private ticksTotal = 0;
  private lastTickTime = 0;
  private previousTickTime = 0;
  private intervalHistory: number[] = [];

  constructor(
    private config: LoopConfig,
    private readonly onTick: () => Promise<void>
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    this.paused = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextScheduledTime = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  pause(): void {
    if (!this.running || this.paused) {
      return;
    }
    this.paused = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextScheduledTime = null;
  }

  resume(): void {
    if (!this.running || !this.paused) {
      return;
    }
    this.paused = false;
    this.scheduleNext();
  }

  updateConfig(config: LoopConfig): void {
    this.config = config;
    if (!this.running) {
      return;
    }
    this.stop();
    this.start();
  }

  getNextScheduledTime(): number | null {
    return this.nextScheduledTime;
  }

  getStats(): HeartbeatStats {
    return {
      ticks_total: this.ticksTotal,
      avg_interval_actual_ms: mean(this.intervalHistory),
      last_tick_time: this.lastTickTime,
      next_scheduled_time: this.nextScheduledTime
    };
  }

  private scheduleNext(): void {
    if (!this.running || this.paused || !this.config.enabled) {
      this.nextScheduledTime = null;
      return;
    }

    let intervalMs = -Math.log(1 - Math.random()) * this.config.heartbeat_lambda_minutes * 60 * 1000;
    intervalMs = Math.max(this.config.min_interval_minutes * 60 * 1000, intervalMs);
    intervalMs = Math.min(this.config.max_interval_minutes * 60 * 1000, intervalMs);

    const now = new Date();
    const hour = now.getHours();
    if (hour < this.config.active_hours.start || hour >= this.config.active_hours.end) {
      intervalMs = this.msUntilHour(this.config.active_hours.start);
    }

    this.nextScheduledTime = Date.now() + intervalMs;
    this.timer = setTimeout(() => {
      void this.handleTick();
    }, intervalMs);
    this.timer.unref?.();
  }

  private async handleTick(): Promise<void> {
    const now = Date.now();
    this.ticksTotal += 1;
    this.lastTickTime = now;
    if (this.previousTickTime > 0) {
      this.intervalHistory.push(now - this.previousTickTime);
    }
    this.previousTickTime = now;

    try {
      await this.onTick();
    } catch (error) {
      console.error("[Heartbeat] tick error:", error);
    }

    this.scheduleNext();
  }

  private msUntilHour(targetHour: number): number {
    const now = new Date();
    const target = new Date(now);
    target.setHours(targetHour, 0, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return target.getTime() - now.getTime();
  }
}
