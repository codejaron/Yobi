import { randomUUID } from "node:crypto";
import { generateObject } from "ai";
import { z } from "zod";
import type {
  AppConfig,
  BufferMessage,
  EmotionalState,
  KernelStatus,
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
  type EmotionalSignals,
  runFactExtraction,
  splitExtractionWindows
} from "@main/memory-v2/extraction-runner";
import {
  readJsonFile,
  writeJsonFileAtomic
} from "@main/storage/fs";

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

  async onUserMessage(ts = new Date().toISOString()): Promise<void> {
    this.events.enqueue({
      id: randomUUID(),
      type: "user-message",
      priority: "P0",
      payload: {
        ts
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

  async runTickNow(): Promise<void> {
    await this.tick();
  }

  async runDailyNow(): Promise<void> {
    await this.scheduleDailyTasks(true);
    await this.taskQueue.processAvailable();
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
    const gapHours = lastTs > 0 ? (currentTs - lastTs) / (3600 * 1000) : 0;
    this.lastUserMessageAt = ts;

    this.input.stateStore.mutate((state) => {
      state.emotional.connection = clamp01(state.emotional.connection + 0.08);
      state.emotional.energy = clamp01(state.emotional.energy + 0.03);
      state.coldStart = false;
      const reentryThreshold = this.input.getConfig().kernel.sessionReentryGapHours;
      if (gapHours >= reentryThreshold) {
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
    this.input.stateStore.mutate((state) => {
      state.emotional.mood += (0 - state.emotional.mood) * 0.06;
      state.emotional.energy = clamp01(state.emotional.energy - 0.005);
      state.emotional.connection = clamp01(state.emotional.connection - 0.0025);
      state.emotional.curiosity = clamp01(state.emotional.curiosity - 0.001);
      state.emotional.irritation = clamp01(state.emotional.irritation - 0.004);

      if (state.emotional.energy < 0.25) {
        state.emotional.curiosity = clamp01(state.emotional.curiosity - 0.003);
      }
      if (state.emotional.connection < 0.2) {
        state.emotional.mood = clampRange(state.emotional.mood - 0.01, -1, 1);
      }
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
    const extractionResult = await runFactExtraction({
      messages,
      existingFacts,
      profileHint,
      modelFactory: this.input.modelFactory,
      config: this.input.getConfig(),
      maxOutputTokens: this.input.getConfig().kernel.factExtraction.maxOutputTokens
    });
    const normalizedOperations = extractionResult.operations.map((operation) => ({
      ...operation,
      fact: {
        ...operation.fact,
        source_range: sourceRange
      }
    }));
    await this.input.memory.getFactsStore().applyOperations(normalizedOperations);
    this.applyEmotionalSignals(extractionResult.emotionalSignals, messages);
    await this.input.memory.markExtractedByRange(sourceRange);
  }

  private applyEmotionalSignals(
    signals: EmotionalSignals | undefined,
    messages: BufferMessage[]
  ): void {
    const config = this.input.getConfig().kernel.emotionSignals;
    if (!config.enabled || !signals) {
      return;
    }

    const latestTs = messages[messages.length - 1]?.ts ?? "";
    const ageScale = computeSignalAgeScale(latestTs, new Date(), config);
    if (ageScale <= 0) {
      return;
    }

    this.input.stateStore.mutate((state) => {
      state.emotional = applyEmotionalSignalsToState({
        emotional: state.emotional,
        signals,
        config,
        ageScale
      });
    });
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
    const summary = [
      `今天共对话 ${todayItems.length} 条，用户消息 ${userMessages.length} 条。`,
      first ? `开场：${shorten(first.text, 40)}` : "",
      last ? `收尾：${shorten(last.text, 40)}` : ""
    ]
      .filter(Boolean)
      .join(" ");
    const episode = this.input.memory.getEpisodesStore().buildEpisode({
      date: today,
      summary,
      significance: userMessages.length >= 10 ? 0.7 : 0.45,
      sourceRanges: [],
      unresolved: []
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
    const result = await generateObject({
      model: this.input.modelFactory.getReflectionModel(),
      providerOptions: resolveOpenAIStoreOption(this.input.getConfig()),
      schema: semanticProfileSchema,
      system:
        "你根据最近对话模式更新用户画像，保持小幅变化，不要发散猜测。只输出 schema 字段。",
      prompt,
      maxOutputTokens: 400
    });
    const parsed = semanticProfileSchema.parse(result.object ?? {});
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
    const result = await generateObject({
      model: this.input.modelFactory.getReflectionModel(),
      providerOptions: resolveOpenAIStoreOption(this.input.getConfig()),
      schema: reflectionSchema,
      system:
        "你是 Yobi 的反思模块，请给出一个可执行的微调建议和评分。分数越高表示证据越充分。",
      prompt,
      maxOutputTokens: 400
    });
    const parsed = reflectionSchema.parse(result.object);
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
    if (!this.lastUserMessageAt) {
      return;
    }

    const now = Date.now();
    const silenceMs = now - new Date(this.lastUserMessageAt).getTime();
    if (silenceMs < config.proactive.silenceThresholdMs) {
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

    const activeTopics = await this.input.memory.listActive(5);
    const topic = activeTopics[0];
    if (!topic) {
      return;
    }

    const message = topic.material
      ? `我刚刷到个东西，感觉你会有兴趣：${topic.text}`
      : `突然想起一件事：${topic.text}`;
    await callback({
      message,
      topicId: topic.id
    });
    this.lastProactiveAt = new Date().toISOString();
  }

  private async evaluateRelationshipTransition(): Promise<void> {
    const historyCount = await this.input.memory.countHistory({
      threadId: this.input.threadId,
      resourceId: this.input.resourceId
    });
    const snapshot = this.input.stateStore.getSnapshot();
    const targetStage = computeTargetStage(historyCount, snapshot.emotional.connection);
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
          state.relationship.stage = targetStage;
          state.relationship.upgradeStreak = 0;
        }
        return;
      }

      if (targetIndex < currentIndex) {
        state.relationship.downgradeStreak += 1;
        state.relationship.upgradeStreak = 0;
        if (state.relationship.downgradeStreak >= downgradeWindow) {
          state.relationship.stage = targetStage;
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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampRange(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampAbsDelta(value: number, maxAbs: number): number {
  return clampRange(value, -Math.abs(maxAbs), Math.abs(maxAbs));
}

function normalizeBufferRow(raw: unknown): BufferMessage | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : "";
  const ts = typeof row.ts === "string" ? row.ts : "";
  const role =
    row.role === "system" || row.role === "assistant" || row.role === "user" ? row.role : null;
  const channel = row.channel === "telegram" || row.channel === "qq" ? row.channel : "console";
  const text = typeof row.text === "string" ? row.text.trim() : "";
  if (!id || !ts || !role || !text) {
    return null;
  }
  return {
    id,
    ts,
    role,
    channel,
    text,
    meta: row.meta && typeof row.meta === "object" ? (row.meta as Record<string, unknown>) : undefined,
    extracted: Boolean(row.extracted)
  };
}

function toDayKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shorten(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 1)}…`;
}

function isWithinQuietHours(
  now: Date,
  quietHours: {
    enabled: boolean;
    startMinuteOfDay: number;
    endMinuteOfDay: number;
  }
): boolean {
  if (!quietHours.enabled) {
    return false;
  }
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  const start = quietHours.startMinuteOfDay;
  const end = quietHours.endMinuteOfDay;
  if (start < end) {
    return currentMinute >= start && currentMinute < end;
  }
  return currentMinute >= start || currentMinute < end;
}

function computeTargetStage(historyCount: number, connection: number): "stranger" | "acquaintance" | "familiar" | "close" | "intimate" {
  if (historyCount >= 400 || connection >= 0.9) {
    return "intimate";
  }
  if (historyCount >= 220 || connection >= 0.78) {
    return "close";
  }
  if (historyCount >= 120 || connection >= 0.62) {
    return "familiar";
  }
  if (historyCount >= 30 || connection >= 0.4) {
    return "acquaintance";
  }
  return "stranger";
}

export function computeSignalAgeScale(
  latestMessageTs: string,
  now: Date,
  config: AppConfig["kernel"]["emotionSignals"]
): number {
  const latestTs = Number.isFinite(new Date(latestMessageTs).getTime())
    ? new Date(latestMessageTs).getTime()
    : now.getTime();
  const ageMinutes = Math.max(0, (now.getTime() - latestTs) / 60_000);
  const fullEffect = config.stalenessFullEffectMinutes;
  const maxAgeMinutes = config.stalenessMaxAgeHours * 60;

  if (ageMinutes <= fullEffect) {
    return 1;
  }
  if (ageMinutes >= maxAgeMinutes) {
    return 0;
  }
  const ratio = (ageMinutes - fullEffect) / Math.max(1, maxAgeMinutes - fullEffect);
  const scaled = 1 - ratio * (1 - config.stalenessMinScale);
  return clampRange(scaled, config.stalenessMinScale, 1);
}

export function applyEmotionalSignalsToState(input: {
  emotional: EmotionalState;
  signals: EmotionalSignals;
  config: AppConfig["kernel"]["emotionSignals"];
  ageScale: number;
}): EmotionalState {
  const scaledDelta = (raw: number): number =>
    clampAbsDelta(raw * input.ageScale, input.config.windowMaxAbsDelta);
  const next: EmotionalState = {
    ...input.emotional
  };

  const moodDelta =
    input.signals.user_mood === "positive"
      ? input.config.moodPositiveStep
      : input.signals.user_mood === "negative"
        ? -input.config.moodNegativeStep
        : 0;
  next.mood = clampRange(next.mood + scaledDelta(moodDelta), -1, 1);

  const energyDelta = (input.signals.engagement - 0.5) * input.config.energyEngagementScale;
  next.energy = clamp01(next.energy + scaledDelta(energyDelta));

  next.connection = clamp01(next.connection + scaledDelta(input.signals.trust_delta));

  const curiosityDelta = input.signals.curiosity_trigger ? input.config.curiosityBoost : 0;
  next.curiosity = clamp01(next.curiosity + scaledDelta(curiosityDelta));

  const confidenceDelta = input.signals.friction
    ? -input.config.confidenceDropOnFriction
    : input.signals.engagement >= input.config.minPositiveEngagement &&
        input.signals.trust_delta >= input.config.minPositiveTrustDelta
      ? input.config.confidenceGain
      : 0;
  next.confidence = clamp01(next.confidence + scaledDelta(confidenceDelta));

  const irritationDelta = input.signals.friction ? input.config.irritationBoostOnFriction : 0;
  next.irritation = clamp01(next.irritation + scaledDelta(irritationDelta));

  return next;
}
