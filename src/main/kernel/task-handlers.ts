import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AppConfig,
  BufferMessage,
  EmotionalState,
  PendingTask,
  PendingTaskType,
  ReflectionProposal,
  RelationshipStage
} from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import { YobiMemory } from "@main/memory/setup";
import { normalizeBufferRow } from "./message-utils";
import { clamp01 } from "./emotion-utils";
import { toDayKey, shorten } from "./relationship-utils";
import {
  readJsonFile,
  writeJsonFileAtomic
} from "@main/storage/fs";
import { reportTokenUsage } from "@main/services/token/token-usage-reporter";
import { BackgroundTaskWorkerService } from "@main/services/background-task-worker";

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

const dailyEpisodeSummarySchema = z.object({
  summary: z.string().min(1).max(240),
  unresolved: z.array(z.string().min(1).max(120)).max(5).default([]),
  significance: z.number().min(0).max(1).default(0.4)
});

export interface KernelQueueTaskHandler {
  readonly type: PendingTaskType;
  handle(task: PendingTask): Promise<void>;
}

export interface ProactiveRewriteHandler {
  rewrite(input: {
    message: string;
    stage: RelationshipStage;
    emotional: EmotionalState;
  }): Promise<string | null>;
  getWorkerStatus(): { available: boolean; message: string };
  getPauseReason(): string | null;
}

interface KernelTaskHandlerContext {
  paths: CompanionPaths;
  memory: YobiMemory;
  getConfig: () => AppConfig;
  backgroundWorker: BackgroundTaskWorkerService;
  resourceId: string;
  threadId: string;
}

export class FactExtractionTaskHandler implements KernelQueueTaskHandler {
  readonly type = "fact-extraction" as const;

  constructor(private readonly context: KernelTaskHandlerContext) {}

  async handle(task: PendingTask): Promise<void> {
    const sourceRange = typeof task.payload.sourceRange === "string" ? task.payload.sourceRange : "";
    if (!sourceRange) {
      return;
    }

    const messagesRaw = Array.isArray(task.payload.messages) ? task.payload.messages : [];
    const messages = messagesRaw
      .map((item) => normalizeBufferRow(item))
      .filter((item): item is BufferMessage => item !== null);
    if (messages.length === 0) {
      return;
    }

    const existingFacts = this.context.memory.getFactsStore().listAll();
    const profileHint = this.context.memory.getProfileStore().getProfile();
    const config = this.context.getConfig();
    const extractionResult = await this.context.backgroundWorker.runFactExtraction({
      messages,
      existingFacts,
      profileHint,
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
    const changedFacts = await this.context.memory.getFactsStore().applyOperations(normalizedOperations);
    await this.context.memory.syncFactEmbeddings(changedFacts);
    await this.context.memory.markExtractedByRange(sourceRange);
  }
}

export class DailyEpisodeTaskHandler implements KernelQueueTaskHandler {
  readonly type = "daily-episode" as const;

  constructor(private readonly context: KernelTaskHandlerContext) {}

  async handle(_task: PendingTask): Promise<void> {
    const history = await this.context.memory.listHistory({
      threadId: this.context.threadId,
      resourceId: this.context.resourceId,
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

    const result = await this.context.backgroundWorker.runDailyEpisode({
      date: today,
      todayItems: todayItems.map((item) => ({ role: item.role, text: item.text })),
      userMessageCount: userMessages.length,
      fallbackSummary,
      config: this.context.getConfig()
    });
    if (result.tokenUsage) {
      reportTokenUsage({
        source: "background:reflection",
        usage: result.tokenUsage,
        inputText: JSON.stringify(todayItems.slice(-80)),
        outputText: JSON.stringify(result)
      });
    }
    const parsed = dailyEpisodeSummarySchema.parse(result);
    const episode = this.context.memory.getEpisodesStore().buildEpisode({
      date: today,
      summary: parsed.summary.trim() || fallbackSummary,
      significance: parsed.significance,
      sourceRanges: [],
      unresolved: parsed.unresolved
    });
    await this.context.memory.getEpisodesStore().saveDailyEpisodes(today, [episode]);
  }
}

export class ProfileSemanticTaskHandler implements KernelQueueTaskHandler {
  readonly type = "profile-semantic-update" as const;

  constructor(private readonly context: KernelTaskHandlerContext) {}

  async handle(_task: PendingTask): Promise<void> {
    const profile = await this.context.memory.getProfile();
    const episodes = await this.context.memory.listRecentEpisodes(7);
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
    const result = await this.context.backgroundWorker.runProfileSemantic({
      profile,
      episodes: episodes.map((episode) => ({ date: episode.date, summary: episode.summary })),
      config: this.context.getConfig()
    });
    if (result.tokenUsage) {
      reportTokenUsage({
        source: "background:reflection",
        usage: result.tokenUsage,
        inputText: prompt,
        outputText: JSON.stringify(result.result ?? {})
      });
    }
    const parsed = semanticProfileSchema.parse(result.result ?? {});
    await this.context.memory.getProfileStore().applySemanticPatch((draft) => {
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
}

export class DailyReflectionTaskHandler implements KernelQueueTaskHandler {
  readonly type = "daily-reflection" as const;

  constructor(private readonly context: KernelTaskHandlerContext) {}

  async handle(_task: PendingTask): Promise<void> {
    const episodes = await this.context.memory.listRecentEpisodes(3);
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
    const result = await this.context.backgroundWorker.runDailyReflection({
      episodes: episodes.map((episode) => ({
        date: episode.date,
        summary: episode.summary,
        significance: episode.significance
      })),
      config: this.context.getConfig()
    });
    if (result.tokenUsage) {
      reportTokenUsage({
        source: "background:reflection",
        usage: result.tokenUsage,
        inputText: prompt,
        outputText: JSON.stringify(result.result ?? {})
      });
    }
    const parsed = reflectionSchema.parse(result.result);
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
      await this.context.memory.getProfileStore().applySemanticPatch((draft) => {
        if (!draft.interaction_notes.what_works.includes(proposal.summary)) {
          draft.interaction_notes.what_works.push(proposal.summary);
        }
      });
    }

    const queue = await readJsonFile<ReflectionProposal[]>(this.context.paths.reflectionQueuePath, []);
    const log = await readJsonFile<ReflectionProposal[]>(this.context.paths.reflectionLogPath, []);

    if (proposal.requires_review) {
      queue.push(proposal);
      await writeJsonFileAtomic(this.context.paths.reflectionQueuePath, queue.slice(-200));
    }
    log.push(proposal);
    await writeJsonFileAtomic(this.context.paths.reflectionLogPath, log.slice(-500));
  }
}

export class WorkerProactiveRewriteHandler implements ProactiveRewriteHandler {
  constructor(
    private readonly input: {
      getConfig: () => AppConfig;
      backgroundWorker: BackgroundTaskWorkerService;
      timeoutMs?: number;
    }
  ) {}

  getWorkerStatus(): { available: boolean; message: string } {
    return this.input.backgroundWorker.getStatus();
  }

  getPauseReason(): string | null {
    return this.getWorkerStatus().available ? null : "background-worker-unavailable";
  }

  async rewrite(input: {
    message: string;
    stage: RelationshipStage;
    emotional: EmotionalState;
  }): Promise<string | null> {
    const trimmed = input.message.trim();
    if (!trimmed) {
      return "";
    }
    if (!this.getWorkerStatus().available) {
      return null;
    }

    try {
      const result = await withTimeout(
        this.input.backgroundWorker.runProactiveRewrite({
          message: trimmed,
          stage: input.stage,
          emotional: input.emotional,
          config: this.input.getConfig()
        }),
        this.input.timeoutMs ?? 10_000,
        "proactive-rewrite-timeout"
      );
      if (result.tokenUsage) {
        reportTokenUsage({
          source: "background:reflection",
          usage: result.tokenUsage,
          inputText: JSON.stringify({
            message: trimmed,
            stage: input.stage,
            emotional: input.emotional
          }),
          outputText: JSON.stringify(result)
        });
      }
      const rewrittenMessage = result.rewrittenMessage.trim();
      return rewrittenMessage || trimmed;
    } catch {
      return null;
    }
  }
}

export function buildKernelQueueTaskHandlers(context: KernelTaskHandlerContext): KernelQueueTaskHandler[] {
  return [
    new FactExtractionTaskHandler(context),
    new DailyEpisodeTaskHandler(context),
    new ProfileSemanticTaskHandler(context),
    new DailyReflectionTaskHandler(context)
  ];
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(label));
    }, timeoutMs);
    timer.unref?.();
    promise.then(resolve).catch(reject).finally(() => clearTimeout(timer));
  });
}
