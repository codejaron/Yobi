import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AppConfig,
  PendingTask,
  PendingTaskType,
  ReflectionProposal
} from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import { YobiMemory } from "@main/memory/setup";
import { clamp01 } from "./emotion-utils";
import { toDayKey, shorten } from "./relationship-utils";
import {
  readJsonFile,
  writeJsonFileAtomic
} from "@main/storage/fs";
import { reportTokenUsage } from "@main/services/token/token-usage-reporter";
import { BackgroundTaskWorkerService } from "@main/services/background-task-worker";
import { appLogger as logger } from "@main/runtime/singletons";

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
  significance: z.number().min(0).max(1).default(0.4),
  user_mood: z.string().min(1).max(30).default("unknown"),
  yobi_mood: z.string().min(1).max(30).default("neutral")
});

export interface KernelQueueTaskHandler {
  readonly type: PendingTaskType;
  handle(task: PendingTask): Promise<void>;
}

interface KernelTaskHandlerContext {
  paths: CompanionPaths;
  memory: YobiMemory;
  getConfig: () => AppConfig;
  backgroundWorker: BackgroundTaskWorkerService;
  resourceId: string;
  threadId: string;
}

export class DailyEpisodeTaskHandler implements KernelQueueTaskHandler {
  readonly type = "daily-episode" as const;

  constructor(private readonly context: KernelTaskHandlerContext) {}

  async handle(task: PendingTask): Promise<void> {
    const history = await this.context.memory.listHistory({
      threadId: this.context.threadId,
      resourceId: this.context.resourceId,
      limit: 5000
    });
    const dayKey = typeof task.payload.dayKey === "string" ? task.payload.dayKey : toDayKey(new Date());
    const dayItems = history.filter((item) => toDayKey(new Date(item.timestamp)) === dayKey);
    if (dayItems.length === 0) {
      return;
    }

    const first = dayItems[0];
    const last = dayItems[dayItems.length - 1];
    const userMessages = dayItems.filter((item) => item.role === "user");
    const fallbackSummary = [
      `当日共对话 ${dayItems.length} 条，用户消息 ${userMessages.length} 条。`,
      first ? `开场：${shorten(first.text, 40)}` : "",
      last ? `收尾：${shorten(last.text, 40)}` : ""
    ]
      .filter(Boolean)
      .join(" ");

    let summary = fallbackSummary;
    let unresolved: string[] = [];
    let significance = 0.4;
    let emotionalContext = {
      user: "unknown",
      yobi: "neutral"
    };
    try {
      const result = await this.context.backgroundWorker.runDailyEpisode({
        date: dayKey,
        dayItems: dayItems.map((item) => ({ role: item.role, text: item.text })),
        userMessageCount: userMessages.length,
        fallbackSummary,
        config: this.context.getConfig()
      });
      if (result.tokenUsage) {
        reportTokenUsage({
          source: "background:daily-summary",
          usage: result.tokenUsage,
          inputText: JSON.stringify(dayItems.slice(-120)),
          outputText: JSON.stringify(result)
        });
      }
      const parsed = dailyEpisodeSummarySchema.parse(result);
      summary = parsed.summary.trim() || fallbackSummary;
      unresolved = parsed.unresolved;
      significance = parsed.significance;
      emotionalContext = {
        user: parsed.user_mood,
        yobi: parsed.yobi_mood
      };
    } catch (error) {
      logger.warn(
        "kernel",
        "daily-episode-fallback",
        {
          date: dayKey,
          historyCount: dayItems.length,
          userMessageCount: userMessages.length
        },
        error
      );
    }

    const episode = this.context.memory.getEpisodesStore().buildEpisode({
      date: dayKey,
      summary,
      significance,
      sourceRanges: [`day:${dayKey}`],
      unresolved,
      emotionalContext
    });
    await this.context.memory.getEpisodesStore().saveDailyEpisodes(dayKey, [episode]);
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
    try {
      const result = await this.context.backgroundWorker.runProfileSemantic({
        profile,
        episodes: episodes.map((episode) => ({ date: episode.date, summary: episode.summary })),
        config: this.context.getConfig()
      });
      if (result.tokenUsage) {
        reportTokenUsage({
          source: "background:profile-update",
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
    } catch (error) {
      logger.warn(
        "kernel",
        "profile-semantic-update-failed",
        {
          episodeCount: episodes.length
        },
        error
      );
      throw error;
    }
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
    try {
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
    } catch (error) {
      logger.warn(
        "kernel",
        "daily-reflection-failed",
        {
          episodeCount: episodes.length
        },
        error
      );
      throw error;
    }
  }
}

export function buildKernelQueueTaskHandlers(context: KernelTaskHandlerContext): KernelQueueTaskHandler[] {
  return [
    new DailyEpisodeTaskHandler(context),
    new ProfileSemanticTaskHandler(context),
    new DailyReflectionTaskHandler(context)
  ];
}
