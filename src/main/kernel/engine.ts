import { randomUUID } from "node:crypto";
import type {
  AppConfig,
  KernelStatus,
  PendingTaskType,
  RealtimeEmotionalSignals
} from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import { YobiMemory } from "@main/memory/setup";
import { KernelEventQueue } from "./event-queue";
import { KernelTaskQueue } from "./task-queue";
import { StateStore } from "./state-store";
import { splitExtractionWindows } from "@main/memory-v2/extraction-runner";
import { BackgroundTaskWorkerService } from "@main/services/background-task-worker";
import {
  applyElapsedEmotionalDecay,
  applyRealtimeEmotionalSignals,
  computeMessageCadenceScale,
  clamp01
} from "./emotion-utils";
import { selectBestProactiveTopic } from "./proactive-utils";
import { computeAverageEpisodeQuality, computeTargetStage, countMeaningfulDays, isWithinQuietHours, toDayKey } from "./relationship-utils";
import type { KernelQueueTaskHandler, ProactiveRewriteHandler } from "./task-handlers";

export {
  computeMessageCadenceScale,
  applyElapsedEmotionalDecay,
  applyRealtimeEmotionalSignals,
  computeSignalAgeScale,
  applyEmotionalSignalsToState
} from "./emotion-utils";
export { selectBestProactiveTopic } from "./proactive-utils";

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
  onProactiveMessage?: (input: { message: string; topicId?: string }) => Promise<void>;
}

export class KernelEngine {
  private readonly events = new KernelEventQueue();
  private readonly taskQueue: KernelTaskQueue;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastTickAt: string | null = null;
  private lastUserMessageAt: string | null = null;
  private lastProactiveAt: string | null = null;
  private dailyRanDayKey: string | null = null;
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
      coldStart: snapshot.coldStart,
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

    this.input.stateStore.mutate((state) => {
      state.emotional = applyRealtimeEmotionalSignals({
        emotional: state.emotional,
        signals,
        config
      });
    });
  }

  async runTickNow(): Promise<void> {
    await this.tick();
  }

  async runDailyNow(): Promise<void> {
    await this.scheduleDailyTasks(true);
    await this.taskQueue.processAvailable();
    await this.taskQueue.drainUntilIdle();
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

    this.applyStateDecay();
    await this.consumeCompactionSignals();
    await this.processQueuedEvents();
    await this.maybeScheduleDailyTasks();
    await this.taskQueue.processAvailable();
    await this.input.memory.backfillFactEmbeddings(10);
    await this.maybeEmitProactiveMessage();
    await this.input.stateStore.flushIfDirty();

    this.lastTickAt = new Date().toISOString();
    this.currentTickIntervalMs = this.resolveTickIntervalMs();
    this.scheduleNextTick(this.currentTickIntervalMs);
  }

  private async processUrgentEvents(): Promise<void> {
    await this.processQueuedEvents({
      maxEvents: 20,
      priorities: new Set(["P0", "P1"])
    });
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
    const cadenceScale = computeMessageCadenceScale(gapMs);
    this.lastUserMessageAt = ts;

    this.input.stateStore.mutate((state) => {
      state.emotional.connection = clamp01(state.emotional.connection + 0.08 * cadenceScale);
      state.emotional.energy = clamp01(state.emotional.energy + 0.03 * cadenceScale);
      state.coldStart = false;
      const reentryThreshold = this.input.getConfig().kernel.sessionReentryGapHours;
      if (typeof gapMs === "number" && gapHours >= reentryThreshold) {
        state.sessionReentry = {
          active: true,
          gapHours: Math.floor(gapHours),
          gapLabel: gapHours >= 24 ? `${Math.floor(gapHours / 24)} 天` : `${Math.floor(gapHours)} 小时`,
          activatedAt: new Date().toISOString()
        };
      } else {
        state.sessionReentry = null;
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
    this.input.stateStore.mutate((state) => {
      const lastDecayAt = state.lastDecayAt ? new Date(state.lastDecayAt).getTime() : NaN;
      state.lastDecayAt = now.toISOString();
      if (!Number.isFinite(lastDecayAt)) {
        return;
      }

      const deltaSeconds = Math.max(0, (now.getTime() - lastDecayAt) / 1000);
      if (deltaSeconds <= 0) {
        return;
      }

      state.emotional = applyElapsedEmotionalDecay(state.emotional, deltaSeconds);
    });
  }

  private async consumeCompactionSignals(): Promise<void> {
    const signals = this.input.memory.drainCompactionSignals();
    if (signals.length === 0) {
      return;
    }

    const enqueueInputs: Array<{
      type: PendingTaskType;
      sourceRange?: string;
      payload: Record<string, unknown>;
    }> = [];

    for (const signal of signals) {
      await this.input.memory.getProfileStore().updateFromStatSignals(signal.removed);
      for (const range of signal.sourceRanges) {
        const [start, end] = range.split("..");
        const windowMessages = signal.removed.filter((message) => message.id >= start && message.id <= end);
        const chunks = splitExtractionWindows({
          messages: windowMessages,
          maxInputTokens: this.input.getConfig().kernel.factExtraction.maxInputTokens
        });
        for (const chunk of chunks) {
          enqueueInputs.push({
            type: "fact-extraction",
            sourceRange: chunk.sourceRange,
            payload: {
              sourceRange: chunk.sourceRange,
              messages: chunk.messages
            }
          });
        }
      }
    }

    await this.taskQueue.enqueueMany(enqueueInputs);
  }

  private async maybeScheduleDailyTasks(): Promise<void> {
    await this.scheduleDailyTasks(false);
  }

  private async scheduleDailyTasks(force: boolean): Promise<void> {
    const now = new Date();
    const dayKey = toDayKey(now);
    const hour = now.getHours();
    const targetHour = this.input.getConfig().kernel.dailyTaskHour;
    if (!force && (hour !== targetHour || this.dailyRanDayKey === dayKey)) {
      return;
    }

    await this.input.memory.getFactsStore().cleanupExpired(now.toISOString());
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
    await this.evaluateRelationshipTransition();
    this.dailyRanDayKey = dayKey;
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
    if (this.lastProactiveAt) {
      const elapsed = now - new Date(this.lastProactiveAt).getTime();
      if (elapsed < config.proactive.cooldownMs) {
        return;
      }
    }
    if (isWithinQuietHours(new Date(now), config.proactive.quietHours)) {
      return;
    }

    const snapshot = this.input.stateStore.getSnapshot();
    const tryEmit = async (message: string, topicId?: string): Promise<boolean> => {
      const rewritten = await this.input.proactiveRewriteHandler.rewrite({
        message,
        stage: snapshot.relationship.stage,
        emotional: snapshot.emotional
      });
      if (!rewritten || !rewritten.trim()) {
        return false;
      }
      await callback({
        message: rewritten.trim(),
        topicId
      });
      this.lastProactiveAt = new Date().toISOString();
      return true;
    };

    if (!this.lastUserMessageAt) {
      if (!snapshot.coldStart || now - this.startedAtMs < config.proactive.coldStartDelayMs) {
        return;
      }
      await tryEmit("嗨，我是 Yobi。今天想让我陪你做点什么吗？");
      return;
    }

    const silenceMs = now - new Date(this.lastUserMessageAt).getTime();
    if (silenceMs < config.proactive.silenceThresholdMs) {
      return;
    }

    const activeTopics = await this.input.memory.listActive(5);
    const interestProfile = await this.input.memory.getInterestProfile();
    const topic = selectBestProactiveTopic(activeTopics, interestProfile, snapshot.emotional.curiosity);
    if (!topic) {
      await tryEmit("我刚刚想到你了，要不要和我聊两句？");
      return;
    }

    const message = topic.material
      ? `我刚刷到个东西，感觉你会有兴趣：${topic.text}`
      : `突然想起一件事：${topic.text}`;
    await tryEmit(message, topic.id);
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
    const rows = await this.input.memory.consumeUnprocessedBuffer();
    if (rows.length === 0) {
      return;
    }
    const chunks = splitExtractionWindows({
      messages: rows,
      maxInputTokens: this.input.getConfig().kernel.factExtraction.maxInputTokens
    });
    await this.taskQueue.enqueueMany(
      chunks.map((chunk) => ({
        type: "fact-extraction",
        sourceRange: chunk.sourceRange,
        payload: {
          sourceRange: chunk.sourceRange,
          messages: chunk.messages
        }
      }))
    );
  }
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
