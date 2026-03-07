import { randomUUID } from "node:crypto";
import { generateObject } from "ai";
import { z } from "zod";
import type {
  AppConfig,
  BufferMessage,
  KernelStatus,
  RealtimeEmotionalSignals,
  ReflectionProposal
} from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import type { ModelFactory } from "@main/core/model-factory";
import { resolveOpenAIStoreOption } from "@main/core/provider-utils";
import { YobiMemory } from "@main/memory/setup";
import { KernelEventQueue } from "./event-queue";
import { KernelTaskQueue } from "./task-queue";
import { StateStore } from "./state-store";
import {
  runFactExtraction,
  splitExtractionWindows
} from "@main/memory-v2/extraction-runner";
import {
  readJsonFile,
  writeJsonFileAtomic
} from "@main/storage/fs";
import { reportTokenUsage } from "@main/services/token/token-usage-reporter";
import { BackgroundTaskWorkerService } from "@main/services/background-task-worker";
import {
  applyElapsedEmotionalDecay,
  applyRealtimeEmotionalSignals,
  computeMessageCadenceScale,
  clamp01
} from "./emotion-utils";
import { selectBestProactiveTopic } from "./proactive-utils";
import { computeAverageEpisodeQuality, computeTargetStage, countMeaningfulDays, isWithinQuietHours, shorten, toDayKey } from "./relationship-utils";
import { normalizeBufferRow } from "./message-utils";

export {
  computeMessageCadenceScale,
  applyElapsedEmotionalDecay,
  applyRealtimeEmotionalSignals,
  computeSignalAgeScale,
  applyEmotionalSignalsToState
} from "./emotion-utils";
export { selectBestProactiveTopic } from "./proactive-utils";

const semanticProfileSchema = z.object({
  preferredComfortStyle: z.string().min(1).max(30).optional(),
  humorReceptivity: z.number().min(0).max(1).optional(),
  adviceReceptivity: z.number().min(0).max(1).optional(),
  emotionalOpenness: z.number().min(0).max(1).optional(),
  whatWorks: z.array(z.string().min(1).max(120)).max(5).default([]),
  whatFails: z.array(z.string().min(1).max(120)).max(5).default([])
});

const reflectionSchema = z.object({
  summary: z.string().min(1).max(200),
  evidence: z.array(z.string().min(1).max(160)).max(5).default([]),
  scores: z.object({
    specificity: z.number().min(0).max(1),
    evidence: z.number().min(0).max(1),
    novelty: z.number().min(0).max(1),
    usefulness: z.number().min(0).max(1)
  })
});

const proactiveRewriteSchema = z.object({
  rewrittenMessage: z.string().min(1).max(160)
});

const dailyEpisodeSummarySchema = z.object({
  summary: z.string().min(1).max(240),
  unresolved: z.array(z.string().min(1).max(120)).max(5).default([]),
  significance: z.number().min(0).max(1).default(0.4)
});

interface KernelEngineInput {
  paths: CompanionPaths;
  memory: YobiMemory;
  modelFactory: ModelFactory;
  stateStore: StateStore;
  getConfig: () => AppConfig;
  resourceId: string;
  threadId: string;
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
  private reflectionLane: Promise<void> = Promise.resolve();
  private readonly backgroundWorker = new BackgroundTaskWorkerService();

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
    await this.backgroundWorker.init();
    this.taskQueue.register("fact-extraction", async (task) => {
      await this.runFactExtractionTask(task.payload);
    });
    this.taskQueue.register("daily-episode", async () => {
      await this.runDailyEpisodeTask();
    });
    this.taskQueue.register("profile-semantic-update", async () => {
      await this.runProfileSemanticTask();
    });
    this.taskQueue.register("daily-reflection", async () => {
      await this.runDailyReflectionTask();
    });
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
    return {
      enabled: this.input.getConfig().kernel.enabled,
      tickIntervalMs: this.currentTickIntervalMs,
      queueDepth: this.events.size() + this.taskQueue.depth(),
      lastTickAt: this.lastTickAt,
      stage: snapshot.relationship.stage,
      coldStart: snapshot.coldStart
    };
  }

  getBackgroundWorkerStatus(): { available: boolean; message: string } {
    return this.backgroundWorker.getStatus();
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
          await this.taskQueue.enqueue({
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
    await this.taskQueue.enqueue({
      type: "daily-episode",
      payload: {
        dayKey
      }
    });
    await this.taskQueue.enqueue({
      type: "profile-semantic-update",
      payload: {
        dayKey
      }
    });
    await this.taskQueue.enqueue({
      type: "daily-reflection",
      payload: {
        dayKey
      }
    });
    await this.evaluateRelationshipTransition();
    this.dailyRanDayKey = dayKey;
  }

  private async runFactExtractionTask(payload: Record<string, unknown>): Promise<void> {
    const sourceRange = typeof payload.sourceRange === "string" ? payload.sourceRange : "";
    if (!sourceRange) {
      return;
    }
    if (this.taskQueue.hasCompletedRange("fact-extraction", sourceRange)) {
      await this.input.memory.markExtractedByRange(sourceRange);
      return;
    }

    const messagesRaw = Array.isArray(payload.messages) ? payload.messages : [];
    const messages = messagesRaw
      .map((item) => normalizeBufferRow(item))
      .filter((item): item is BufferMessage => item !== null);
    if (messages.length === 0) {
      return;
    }

    const existingFacts = this.input.memory.getFactsStore().listAll();
    const profileHint = this.input.memory.getProfileStore().getProfile();
    const config = this.input.getConfig();
    const extractionResult = this.backgroundWorker.getStatus().available
      ? await this.backgroundWorker.runFactExtraction({
          messages,
          existingFacts,
          profileHint,
          config,
          maxOutputTokens: config.kernel.factExtraction.maxOutputTokens
        })
      : await runFactExtraction({
          messages,
          existingFacts,
          profileHint,
          modelFactory: this.input.modelFactory,
          config,
          maxOutputTokens: config.kernel.factExtraction.maxOutputTokens
        });
    if (extractionResult.tokenUsage) {
      reportTokenUsage({
        source: "background:fact-extraction",
        usage: extractionResult.tokenUsage,
        inputText: JSON.stringify(messages),
        outputText: JSON.stringify(extractionResult.operations)
      });
    }
    const normalizedOperations = extractionResult.operations.map((operation) => ({
      ...operation,
      fact: {
        ...operation.fact,
        source_range: sourceRange
      }
    }));
    const changedFacts = await this.input.memory.getFactsStore().applyOperations(normalizedOperations);
    await this.input.memory.syncFactEmbeddings(changedFacts);
    await this.input.memory.markExtractedByRange(sourceRange);
  }

  private async runDailyEpisodeTask(): Promise<void> {
    const history = await this.input.memory.listHistory({
      threadId: this.input.threadId,
      resourceId: this.input.resourceId,
      limit: 5000
    });
    const today = toDayKey(new Date());
    const todayItems = history.filter((item) => toDayKey(new Date(item.timestamp)) === today);
    if (todayItems.length === 0) {
      return;
    }

    const first = todayItems[0];
    const last = todayItems[todayItems.length - 1];
    const userMessages = todayItems.filter((item) => item.role === "user");
    const fallbackSummary = [
      `今天共对话 ${todayItems.length} 条，用户消息 ${userMessages.length} 条。`,
      first ? `开场：${shorten(first.text, 40)}` : "",
      last ? `收尾：${shorten(last.text, 40)}` : ""
    ]
      .filter(Boolean)
      .join(" ");

    let summary = fallbackSummary;
    let unresolved: string[] = [];
    let significance = Math.min(0.6, userMessages.length / 20);

    try {
      if (this.backgroundWorker.getStatus().available) {
        const result = await this.backgroundWorker.runDailyEpisode({
          date: today,
          todayItems: todayItems.map((item) => ({ role: item.role, text: item.text })),
          userMessageCount: userMessages.length,
          fallbackSummary,
          config: this.input.getConfig()
        });
        if (result.tokenUsage) {
          reportTokenUsage({
            source: "background:reflection",
            usage: result.tokenUsage,
            inputText: JSON.stringify(todayItems.slice(-80)),
            outputText: JSON.stringify(result)
          });
        }
        summary = result.summary.trim() || fallbackSummary;
        unresolved = result.unresolved;
        significance = result.significance;
      } else {
        const system = "你负责把当天对话整理成一条简短 episode，总结当天对话、未解事项和重要性。";
        const prompt = JSON.stringify({
          date: today,
          message_window: todayItems.slice(-80).map((item) => ({
            role: item.role,
            text: item.text
          }))
        });
        const result = await this.runOnReflectionLane(() =>
          generateObject({
            model: this.input.modelFactory.getReflectionModel(),
            providerOptions: resolveOpenAIStoreOption(this.input.getConfig()),
            schema: dailyEpisodeSummarySchema,
            system,
            prompt,
            maxOutputTokens: 240
          })
        );
        reportTokenUsage({
          source: "background:reflection",
          usage: result.usage,
          systemText: system,
          inputText: prompt,
          outputText: JSON.stringify(result.object ?? {})
        });
        const parsed = dailyEpisodeSummarySchema.parse(result.object ?? {});
        summary = parsed.summary.trim() || fallbackSummary;
        unresolved = parsed.unresolved;
        significance = parsed.significance;
      }
    } catch {}

    const episode = this.input.memory.getEpisodesStore().buildEpisode({
      date: today,
      summary,
      significance,
      sourceRanges: [],
      unresolved
    });
    await this.input.memory.getEpisodesStore().saveDailyEpisodes(today, [episode]);
  }

  private async runProfileSemanticTask(): Promise<void> {
    const profile = await this.input.memory.getProfile();
    const episodes = await this.input.memory.listRecentEpisodes(7);
    if (episodes.length === 0) {
      return;
    }
    const prompt = JSON.stringify(
      {
        profile,
        recent_episodes: episodes.map((episode) => ({
          date: episode.date,
          summary: episode.summary
        }))
      },
      null,
      2
    );
    let parsed;
    if (this.backgroundWorker.getStatus().available) {
      const result = await this.backgroundWorker.runProfileSemantic({
        profile,
        episodes: episodes.map((episode) => ({ date: episode.date, summary: episode.summary })),
        config: this.input.getConfig()
      });
      if (result.tokenUsage) {
        reportTokenUsage({
          source: "background:reflection",
          usage: result.tokenUsage,
          inputText: prompt,
          outputText: JSON.stringify(result.result ?? {})
        });
      }
      parsed = semanticProfileSchema.parse(result.result ?? {});
    } else {
      const semanticSystem = "你根据最近对话模式更新用户画像，保持小幅变化，不要发散猜测。只输出 schema 字段。";
      const result = await this.runOnReflectionLane(() =>
        generateObject({
          model: this.input.modelFactory.getReflectionModel(),
          providerOptions: resolveOpenAIStoreOption(this.input.getConfig()),
          schema: semanticProfileSchema,
          system: semanticSystem,
          prompt,
          maxOutputTokens: 400
        })
      );
      reportTokenUsage({
        source: "background:reflection",
        usage: result.usage,
        systemText: semanticSystem,
        inputText: prompt,
        outputText: JSON.stringify(result.object ?? {})
      });
      parsed = semanticProfileSchema.parse(result.object ?? {});
    }
    await this.input.memory.getProfileStore().applySemanticPatch((draft) => {
      if (parsed.preferredComfortStyle) {
        draft.communication.preferred_comfort_style = parsed.preferredComfortStyle;
      }
      if (typeof parsed.humorReceptivity === "number") {
        draft.communication.humor_receptivity = clamp01(parsed.humorReceptivity);
      }
      if (typeof parsed.adviceReceptivity === "number") {
        draft.communication.advice_receptivity = clamp01(parsed.adviceReceptivity);
      }
      if (typeof parsed.emotionalOpenness === "number") {
        draft.communication.emotional_openness = clamp01(parsed.emotionalOpenness);
      }
      for (const item of parsed.whatWorks) {
        if (!draft.interaction_notes.what_works.includes(item)) {
          draft.interaction_notes.what_works.push(item);
        }
      }
      for (const item of parsed.whatFails) {
        if (!draft.interaction_notes.what_fails.includes(item)) {
          draft.interaction_notes.what_fails.push(item);
        }
      }
      draft.interaction_notes.what_works = draft.interaction_notes.what_works.slice(-20);
      draft.interaction_notes.what_fails = draft.interaction_notes.what_fails.slice(-20);
    });
  }

  private async runDailyReflectionTask(): Promise<void> {
    const episodes = await this.input.memory.listRecentEpisodes(3);
    if (episodes.length === 0) {
      return;
    }
    const prompt = JSON.stringify(
      {
        recent_episodes: episodes.map((episode) => ({
          date: episode.date,
          summary: episode.summary,
          significance: episode.significance
        }))
      },
      null,
      2
    );
    let parsed;
    if (this.backgroundWorker.getStatus().available) {
      const result = await this.backgroundWorker.runDailyReflection({
        episodes: episodes.map((episode) => ({ date: episode.date, summary: episode.summary, significance: episode.significance })),
        config: this.input.getConfig()
      });
      if (result.tokenUsage) {
        reportTokenUsage({
          source: "background:reflection",
          usage: result.tokenUsage,
          inputText: prompt,
          outputText: JSON.stringify(result.result ?? {})
        });
      }
      parsed = reflectionSchema.parse(result.result);
    } else {
      const reflectionSystem = "你是 Yobi 的反思模块，请给出一个可执行的微调建议和评分。分数越高表示证据越充分。";
      const result = await this.runOnReflectionLane(() =>
        generateObject({
          model: this.input.modelFactory.getReflectionModel(),
          providerOptions: resolveOpenAIStoreOption(this.input.getConfig()),
          schema: reflectionSchema,
          system: reflectionSystem,
          prompt,
          maxOutputTokens: 400
        })
      );
      reportTokenUsage({
        source: "background:reflection",
        usage: result.usage,
        systemText: reflectionSystem,
        inputText: prompt,
        outputText: JSON.stringify(result.object ?? {})
      });
      parsed = reflectionSchema.parse(result.object);
    }
    const average =
      (parsed.scores.specificity + parsed.scores.evidence + parsed.scores.novelty + parsed.scores.usefulness) /
      4;
    const proposal: ReflectionProposal = {
      id: randomUUID(),
      created_at: new Date().toISOString(),
      summary: parsed.summary,
      evidence: parsed.evidence,
      scores: parsed.scores,
      risk: average >= 0.75 ? "low" : "high",
      requires_review: average < 0.75,
      applied: average >= 0.75
    };

    if (proposal.applied) {
      await this.input.memory.getProfileStore().applySemanticPatch((draft) => {
        if (!draft.interaction_notes.what_works.includes(proposal.summary)) {
          draft.interaction_notes.what_works.push(proposal.summary);
        }
      });
    }

    const queue = await readJsonFile<ReflectionProposal[]>(this.input.paths.reflectionQueuePath, []);
    const log = await readJsonFile<ReflectionProposal[]>(this.input.paths.reflectionLogPath, []);

    if (proposal.requires_review) {
      queue.push(proposal);
      await writeJsonFileAtomic(this.input.paths.reflectionQueuePath, queue.slice(-200));
    }
    log.push(proposal);
    await writeJsonFileAtomic(this.input.paths.reflectionLogPath, log.slice(-500));
  }

  private async runOnReflectionLane<T>(task: () => Promise<T>): Promise<T> {
    const run = this.reflectionLane.catch(() => undefined).then(task);
    this.reflectionLane = run.then(() => undefined, () => undefined);
    return run;
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(label));
      }, timeoutMs);
      timer.unref?.();
      promise.then(resolve).catch(reject).finally(() => clearTimeout(timer));
    });
  }

  private async maybeRewriteProactiveMessage(baseMessage: string): Promise<string> {
    const trimmed = baseMessage.trim();
    if (!trimmed) {
      return trimmed;
    }

    try {
      const system = "你负责把 Yobi 的主动消息改写得更自然、更像陪伴式搭话。保持原意，输出 rewrittenMessage。";
      const prompt = JSON.stringify({
        message: trimmed,
        stage: this.input.stateStore.getSnapshot().relationship.stage,
        emotional: this.input.stateStore.getSnapshot().emotional
      });
      const result = await this.withTimeout(
        this.runOnReflectionLane(() =>
          generateObject({
            model: this.input.modelFactory.getReflectionModel(),
            providerOptions: resolveOpenAIStoreOption(this.input.getConfig()),
            schema: proactiveRewriteSchema,
            system,
            prompt,
            maxOutputTokens: 160
          })
        ),
        10_000,
        "proactive-rewrite-timeout"
      );
      reportTokenUsage({
        source: "background:reflection",
        usage: result.usage,
        systemText: system,
        inputText: prompt,
        outputText: JSON.stringify(result.object ?? {})
      });
      return proactiveRewriteSchema.parse(result.object ?? {}).rewrittenMessage.trim() || trimmed;
    } catch {
      return trimmed;
    }
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
    if (!this.lastUserMessageAt) {
      if (!snapshot.coldStart || now - this.startedAtMs < config.proactive.coldStartDelayMs) {
        return;
      }

      await callback({
        message: await this.maybeRewriteProactiveMessage("嗨，我是 Yobi。今天想让我陪你做点什么吗？")
      });
      this.lastProactiveAt = new Date().toISOString();
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
      await callback({
        message: await this.maybeRewriteProactiveMessage("我刚刚想到你了，要不要和我聊两句？")
      });
      this.lastProactiveAt = new Date().toISOString();
      return;
    }

    const message = topic.material
      ? `我刚刷到个东西，感觉你会有兴趣：${topic.text}`
      : `突然想起一件事：${topic.text}`;
    await callback({
      message: await this.maybeRewriteProactiveMessage(message),
      topicId: topic.id
    });
    this.lastProactiveAt = new Date().toISOString();
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
    for (const chunk of chunks) {
      await this.taskQueue.enqueue({
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
