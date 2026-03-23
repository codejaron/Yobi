import { randomUUID } from "node:crypto";
import type {
  AppConfig,
  KernelStatus,
  KernelStateDocument,
  PendingTaskType,
  RealtimeEmotionalSignals
} from "@shared/types";
import { getSessionWarmthBaseline } from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import { YobiMemory } from "@main/memory/setup";
import { KernelEventQueue } from "./event-queue";
import { KernelTaskQueue } from "./task-queue";
import { StateStore } from "./state-store";
import { BackgroundTaskWorkerService } from "@main/services/background-task-worker";
import { appLogger as logger } from "@main/runtime/singletons";
import {
  advanceEmotionalRumination,
  applyElapsedEmotionalDecay,
  applyRealtimeEmotionalSignals,
  clampRange
} from "./emotion-utils";
import { computeAverageEpisodeQuality, computeTargetStage, countMeaningfulDays, isWithinQuietHours, toDayKey } from "./relationship-utils";
import type { KernelQueueTaskHandler, ProactiveRewriteHandler } from "./task-handlers";

export {
  advanceEmotionalRumination,
  applyElapsedEmotionalDecay,
  applyRealtimeEmotionalSignals,
  computeSignalAgeScale,
  applyEmotionalSignalsToState
} from "./emotion-utils";

interface KernelEngineInput {
  paths: CompanionPaths;
  memory: YobiMemory;
  stateStore: StateStore;
  getConfig: () => AppConfig;
  resourceId: string;
  threadId: string;
  backgroundWorker: BackgroundTaskWorkerService;
  queueHandlers: KernelQueueTaskHandler[];
  proactiveRewriteHandler: ProactiveRewriteHandler;
  onProactiveMessage?: (input: { message: string }) => Promise<void>;
}

export class KernelEngine {
  private readonly events = new KernelEventQueue();
  private readonly taskQueue: KernelTaskQueue;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastTickAt: string | null = null;
  private lastUserMessageAt: string | null = null;
  private lastProactiveAt: string | null = null;
  private lastEngagement: number | null = null;
  private warmthIdleMinutesApplied = 0;
  private currentTickIntervalMs = 30_000;
  private readonly startedAtMs = Date.now();

  constructor(private readonly input: KernelEngineInput) {
    const config = input.getConfig().kernel;
    this.taskQueue = new KernelTaskQueue(
      input.paths,
      config.queue.maxConcurrent,
      config.queue.retryLimit
    );
  }

  async init(): Promise<void> {
    await this.taskQueue.init();
    await this.input.backgroundWorker.init();
    this.syncPersonalityFromConfig();
    assertUniqueQueueHandlerTypes(this.input.queueHandlers);
    for (const handler of this.input.queueHandlers) {
      this.taskQueue.register(handler.type, async (task) => {
        await handler.handle(task);
      });
    }
    await this.bootstrapUnprocessedTasks();
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.scheduleNextTick(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.input.stateStore.forceFlush();
  }

  getStatus(): KernelStatus {
    const snapshot = this.input.stateStore.getSnapshot();
    const worker = this.input.backgroundWorker.getStatus();
    return {
      enabled: this.input.getConfig().kernel.enabled,
      tickIntervalMs: this.currentTickIntervalMs,
      queueDepth: this.events.size() + this.taskQueue.depth(),
      lastTickAt: this.lastTickAt,
      stage: snapshot.relationship.stage,
      workerAvailable: worker.available,
      workerMessage: worker.message,
      proactivePausedReason: this.input.proactiveRewriteHandler.getPauseReason()
    };
  }

  getBackgroundWorkerStatus(): { available: boolean; message: string } {
    return this.input.backgroundWorker.getStatus();
  }

  setLastUserMessageAt(value: string | null): void {
    if (!value || !Number.isFinite(new Date(value).getTime())) {
      this.lastUserMessageAt = null;
      this.warmthIdleMinutesApplied = 0;
      return;
    }
    this.lastUserMessageAt = new Date(value).toISOString();
  }

  setLastProactiveAt(value: string | null): void {
    if (!value || !Number.isFinite(new Date(value).getTime())) {
      this.lastProactiveAt = null;
      return;
    }
    this.lastProactiveAt = new Date(value).toISOString();
  }

  async onUserMessage(input: { ts?: string; text?: string } = {}): Promise<void> {
    this.events.enqueue({
      id: randomUUID(),
      type: "user-message",
      priority: "P0",
      payload: {
        ts: input.ts ?? new Date().toISOString(),
        text: typeof input.text === "string" ? input.text : ""
      }
    });
    await this.processUrgentEvents();
  }

  async onAssistantMessage(): Promise<void> {
    this.events.enqueue({
      id: randomUUID(),
      type: "assistant-message",
      priority: "P1"
    });
    await this.processUrgentEvents();
  }

  onRealtimeEmotionalSignals(signals: RealtimeEmotionalSignals | null | undefined): void {
    const config = this.input.getConfig().kernel.emotionSignals;
    if (!config.enabled || !signals) {
      return;
    }

    this.lastEngagement = clampRange(signals.engagement, 0, 1);
    const before = this.input.stateStore.getSnapshot();
    const after = this.input.stateStore.mutate((state) => {
      state.personality = {
        ...this.input.getConfig().kernel.personality
      };
      const next = applyRealtimeEmotionalSignals({
        emotional: state.emotional,
        personality: state.personality,
        ruminationQueue: state.ruminationQueue,
        signals,
        config,
        latestMessageTs: this.lastUserMessageAt
      });
      state.emotional = next.emotional;
      state.ruminationQueue = next.ruminationQueue;
    });
    logger.info("kernel", "emotion-signals-applied", {
      signals,
      before: summarizeEmotionalState(before),
      after: summarizeEmotionalState(after)
    });
  }

  syncPersonalityFromConfig(): void {
    const personality = this.input.getConfig().kernel.personality;
    this.input.stateStore.mutate((state) => {
      state.personality = {
        ...personality
      };
    });
  }

  async runTickNow(): Promise<void> {
    if (!this.running) {
      return;
    }
    await this.runTickCycle();
  }

  async runDailyNow(): Promise<void> {
    await this.scheduleDailyTasks(true);
    await this.enqueueUnprocessedBufferTasks();
    await this.taskQueue.processAvailable();
    await this.taskQueue.drainUntilIdle();
    await this.maybeFinalizeDailyTasks();
    await this.taskQueue.compactCompleted();
    await this.input.stateStore.flushIfDirty();
  }

  private scheduleNextTick(delayMs: number): void {
    if (!this.running) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      void this.tick();
    }, Math.max(0, delayMs));
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (!this.running) {
      return;
    }

    try {
      await this.runTickCycle();
    } catch (error) {
      logger.error("kernel", "tick-failed", undefined, error);
    } finally {
      if (!this.running) {
        return;
      }
      this.currentTickIntervalMs = this.resolveTickIntervalMs();
      this.scheduleNextTick(this.currentTickIntervalMs);
    }
  }

  private async runTickCycle(): Promise<void> {
    this.applyStateDecay();
    await this.processQueuedEvents();
    await this.maybeScheduleDailyTasks();
    await this.taskQueue.processAvailable();
    await this.maybeFinalizeDailyTasks();
    await this.input.memory.backfillFactEmbeddings(10);
    await this.maybeEmitProactiveMessage();
    await this.input.stateStore.flushIfDirty();

    this.lastTickAt = new Date().toISOString();
  }

  private async processUrgentEvents(): Promise<void> {
    await this.processQueuedEvents({
      maxEvents: 20,
      priorities: new Set(["P0", "P1"])
    });
    await this.taskQueue.processAvailable();
    await this.maybeFinalizeDailyTasks();
    await this.input.stateStore.flushIfDirty();
  }

  private async processQueuedEvents(input?: {
    maxEvents?: number;
    priorities?: Set<"P0" | "P1" | "P2" | "P3">;
  }): Promise<void> {
    const max = input?.maxEvents ?? 200;
    let processed = 0;
    while (processed < max) {
      const next = this.events.dequeue();
      if (!next) {
        break;
      }
      if (input?.priorities && !input.priorities.has(next.priority)) {
        this.events.enqueue(next);
        break;
      }
      processed += 1;

      if (next.type === "user-message") {
        const ts = typeof next.payload?.ts === "string" ? next.payload.ts : new Date().toISOString();
        this.handleUserMessageEvent(ts);
        continue;
      }

      if (next.type === "assistant-message") {
        this.handleAssistantMessageEvent();
      }
    }
  }

  private handleUserMessageEvent(ts: string): void {
    const currentTs = new Date(ts).getTime();
    const lastTs = this.lastUserMessageAt ? new Date(this.lastUserMessageAt).getTime() : 0;
    const gapMs = lastTs > 0 ? Math.max(0, currentTs - lastTs) : null;
    const gapHours = typeof gapMs === "number" ? gapMs / (3600 * 1000) : 0;
    this.lastUserMessageAt = ts;
    this.warmthIdleMinutesApplied = 0;

    this.input.stateStore.mutate((state) => {
      const reentryThreshold = this.input.getConfig().kernel.sessionReentryGapHours;
      const stageBaseline = getSessionWarmthBaseline(state.relationship.stage);
      if (typeof gapMs === "number" && gapHours >= reentryThreshold) {
        state.sessionReentry = {
          active: true,
          gapHours: Math.floor(gapHours),
          gapLabel: gapHours >= 24 ? `${Math.floor(gapHours / 24)} 天` : `${Math.floor(gapHours)} 小时`,
          activatedAt: new Date().toISOString()
        };
        state.emotional.sessionWarmth = stageBaseline;
      } else {
        state.sessionReentry = null;
      }

      if (typeof this.lastEngagement === "number") {
        state.emotional.sessionWarmth = clampRange(
          state.emotional.sessionWarmth + 0.05 * this.lastEngagement,
          stageBaseline,
          1
        );
      }
    });
  }

  private handleAssistantMessageEvent(): void {
    this.input.stateStore.mutate((state) => {
      if (!state.sessionReentry?.active) {
        return;
      }
      state.sessionReentry = null;
    });
  }

  private applyStateDecay(): void {
    const now = new Date();
    const personality = this.input.getConfig().kernel.personality;
    this.input.stateStore.mutate((state) => {
      const lastDecayAt = state.lastDecayAt ? new Date(state.lastDecayAt).getTime() : NaN;
      state.personality = {
        ...personality
      };
      state.lastDecayAt = now.toISOString();
      if (Number.isFinite(lastDecayAt)) {
        const deltaSeconds = Math.max(0, (now.getTime() - lastDecayAt) / 1000);
        if (deltaSeconds > 0) {
          state.emotional = applyElapsedEmotionalDecay({
            emotional: state.emotional,
            personality: state.personality,
            deltaSeconds
          });
        }
      }

      const rumination = advanceEmotionalRumination({
        emotional: state.emotional,
        ruminationQueue: state.ruminationQueue
      });
      state.emotional = rumination.emotional;
      state.ruminationQueue = rumination.ruminationQueue;
      this.applySessionWarmthIdleDecay(state, now);
    });
  }

  private applySessionWarmthIdleDecay(state: KernelStateDocument, now: Date): void {
    if (!this.lastUserMessageAt) {
      this.warmthIdleMinutesApplied = 0;
      return;
    }

    const lastUserMs = new Date(this.lastUserMessageAt).getTime();
    if (!Number.isFinite(lastUserMs)) {
      this.warmthIdleMinutesApplied = 0;
      return;
    }

    const idleMinutesNow = Math.max(0, (now.getTime() - lastUserMs) / 60_000 - 10);
    if (idleMinutesNow <= 0) {
      this.warmthIdleMinutesApplied = 0;
      return;
    }

    const deltaIdleMinutes = Math.max(0, idleMinutesNow - this.warmthIdleMinutesApplied);
    if (deltaIdleMinutes <= 0) {
      return;
    }

    const stageBaseline = getSessionWarmthBaseline(state.relationship.stage);
    state.emotional.sessionWarmth = clampRange(
      state.emotional.sessionWarmth - 0.02 * deltaIdleMinutes,
      stageBaseline,
      1
    );
    this.warmthIdleMinutesApplied = idleMinutesNow;
  }

  private async maybeScheduleDailyTasks(): Promise<void> {
    await this.scheduleDailyTasks(false);
  }

  private async scheduleDailyTasks(force: boolean): Promise<void> {
    const now = new Date();
    const hour = now.getHours();
    const targetHour = this.input.getConfig().kernel.dailyTaskHour;
    const ready = force || hour >= targetHour;
    if (!ready) {
      return;
    }
    const targetDate = new Date(now.getTime());
    targetDate.setDate(targetDate.getDate() - 1);
    const dayKey = toDayKey(targetDate);
    const lastDailyTaskDayKey = this.input.stateStore.getSnapshot().lastDailyTaskDayKey ?? null;
    if (!force && lastDailyTaskDayKey === dayKey) {
      return;
    }
    const alreadyQueuedForDay = this.taskQueue.list().some(
      (task) =>
        (task.type === "daily-episode" ||
          task.type === "profile-semantic-update" ||
          task.type === "daily-reflection") &&
        task.payload.dayKey === dayKey &&
        (task.status === "pending" || task.status === "running" || task.status === "completed")
    );
    if (!force && alreadyQueuedForDay) {
      return;
    }

    await this.input.memory.getFactsStore().cleanupExpired(
      now.toISOString(),
      this.input.getConfig().memory.facts.activeSoftCap
    );
    await this.taskQueue.enqueueMany([
      {
        type: "daily-episode",
        payload: { dayKey }
      },
      {
        type: "profile-semantic-update",
        payload: { dayKey }
      },
      {
        type: "daily-reflection",
        payload: { dayKey }
      }
    ]);
  }

  private async enqueueUnprocessedBufferTasks(): Promise<void> {
    return;
  }

  private async maybeFinalizeDailyTasks(): Promise<void> {
    const lastDailyTaskDayKey = this.input.stateStore.getSnapshot().lastDailyTaskDayKey ?? null;
    const dailyTasks = this.taskQueue
      .list()
      .filter(
        (task) =>
          (task.type === "daily-episode" ||
            task.type === "profile-semantic-update" ||
            task.type === "daily-reflection") &&
          typeof task.payload.dayKey === "string"
      );
    const dayKeys = [...new Set(dailyTasks.map((task) => String(task.payload.dayKey)).filter(Boolean))].sort();
    const nextDayKey = dayKeys.reverse().find((dayKey) => dayKey !== lastDailyTaskDayKey);
    if (!nextDayKey) {
      return;
    }

    const tasksForDay = dailyTasks.filter((task) => task.payload.dayKey === nextDayKey);
    const hasPending = tasksForDay.some((task) => task.status === "pending" || task.status === "running");
    if (hasPending) {
      return;
    }

    const episodeCompleted = tasksForDay.some(
      (task) => task.type === "daily-episode" && task.status === "completed"
    );
    if (!episodeCompleted) {
      return;
    }

    await this.evaluateRelationshipTransition();
    this.input.stateStore.mutate((state) => {
      state.lastDailyTaskDayKey = nextDayKey;
    });
  }

  private resolveTickIntervalMs(): number {
    const kernel = this.input.getConfig().kernel;
    const now = Date.now();
    const lastUser = this.lastUserMessageAt ? new Date(this.lastUserMessageAt).getTime() : 0;
    if (lastUser > 0) {
      const silence = now - lastUser;
      if (silence <= 5 * 60_000) {
        return kernel.tick.activeIntervalMs;
      }
      if (silence <= 30 * 60_000) {
        return kernel.tick.warmIntervalMs;
      }
      if (silence <= 6 * 3600 * 1000) {
        return kernel.tick.idleIntervalMs;
      }
    }
    return kernel.tick.quietIntervalMs;
  }

  private async maybeEmitProactiveMessage(): Promise<void> {
    const callback = this.input.onProactiveMessage;
    const config = this.input.getConfig();
    if (!callback || !config.proactive.enabled) {
      return;
    }

    if (this.input.proactiveRewriteHandler.getPauseReason()) {
      return;
    }

    const now = Date.now();

    if (now - this.startedAtMs < config.proactive.coldStartDelayMs) {
      return;
    }

    if (this.lastProactiveAt) {
      const elapsed = now - new Date(this.lastProactiveAt).getTime();
      if (elapsed < config.proactive.cooldownMs) {
        return;
      }
    }
    if (isWithinQuietHours(new Date(now), config.proactive.quietHours)) {
      return;
    }

    if (!this.lastUserMessageAt) {
      return;
    }

    const snapshot = this.input.stateStore.getSnapshot();

    const recentHistory = await this.input.memory.listHistory({
      threadId: this.input.threadId,
      resourceId: this.input.resourceId,
      limit: 10
    });

    const tryEmit = async (message: string): Promise<boolean> => {
      const rewritten = await this.input.proactiveRewriteHandler.rewrite({
        message,
        stage: snapshot.relationship.stage,
        emotional: snapshot.emotional,
        recentHistory: recentHistory.map((item) => ({
          role: item.role,
          text: item.text,
          timestamp: item.timestamp,
          proactive: item.meta?.proactive ?? false
        })),
        lastProactiveAt: this.lastProactiveAt,
        lastUserMessageAt: this.lastUserMessageAt,
        now: new Date(now).toISOString()
      });
      if (!rewritten || !rewritten.trim()) {
        return false;
      }
      await callback({
        message: rewritten.trim()
      });
      this.lastProactiveAt = new Date().toISOString();
      return true;
    };

    const silenceMs = now - new Date(this.lastUserMessageAt).getTime();
    if (silenceMs < config.proactive.silenceThresholdMs) {
      return;
    }

    await tryEmit("想找你随便聊聊");
  }

  private async evaluateRelationshipTransition(): Promise<void> {
    const [historyCount, recentEpisodes] = await Promise.all([
      this.input.memory.countHistory({
        threadId: this.input.threadId,
        resourceId: this.input.resourceId
      }),
      this.input.memory.listRecentEpisodes(7)
    ]);
    const snapshot = this.input.stateStore.getSnapshot();
    const meaningfulDays7d = countMeaningfulDays(recentEpisodes);
    const recentEpisodeQuality7d = computeAverageEpisodeQuality(recentEpisodes);
    const targetStage = computeTargetStage(
      historyCount,
      snapshot.emotional.connection,
      meaningfulDays7d,
      recentEpisodeQuality7d
    );
    const stages = ["stranger", "acquaintance", "familiar", "close", "intimate"] as const;
    const currentIndex = stages.indexOf(snapshot.relationship.stage);
    const targetIndex = stages.indexOf(targetStage);

    this.input.stateStore.mutate((state) => {
      const upgradeWindow = this.input.getConfig().kernel.relationship.upgradeWindowDays;
      const downgradeWindow = this.input.getConfig().kernel.relationship.downgradeWindowDays;
      if (targetIndex > currentIndex) {
        state.relationship.upgradeStreak += 1;
        state.relationship.downgradeStreak = 0;
        if (state.relationship.upgradeStreak >= upgradeWindow) {
          state.relationship.stage = stages[Math.min(stages.length - 1, currentIndex + 1)] ?? targetStage;
          state.relationship.upgradeStreak = 0;
        }
        return;
      }

      if (targetIndex < currentIndex) {
        state.relationship.downgradeStreak += 1;
        state.relationship.upgradeStreak = 0;
        if (state.relationship.downgradeStreak >= downgradeWindow) {
          state.relationship.stage = stages[Math.max(0, currentIndex - 1)] ?? targetStage;
          state.relationship.downgradeStreak = 0;
        }
        return;
      }

      state.relationship.upgradeStreak = 0;
      state.relationship.downgradeStreak = 0;
    });
  }

  private async bootstrapUnprocessedTasks(): Promise<void> {
    await this.enqueueUnprocessedBufferTasks();
  }
}

function summarizeEmotionalState(state: KernelStateDocument): Record<string, unknown> {
  return {
    dimensions: {
      ...state.emotional.dimensions
    },
    ekman: {
      ...state.emotional.ekman
    },
    connection: state.emotional.connection,
    sessionWarmth: state.emotional.sessionWarmth,
    ruminationCount: state.ruminationQueue.length
  };
}

export function assertUniqueQueueHandlerTypes(handlers: KernelQueueTaskHandler[]): void {
  const seen = new Set<PendingTaskType>();
  for (const handler of handlers) {
    if (seen.has(handler.type)) {
      throw new Error(`duplicate-kernel-task-handler:${handler.type}`);
    }
    seen.add(handler.type);
  }
}
