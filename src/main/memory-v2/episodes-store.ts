import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Episode } from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import { fileExists, readJsonFile, writeJsonFileAtomic } from "@main/storage/fs";
import { promises as fs } from "node:fs";

export interface EpisodeInput {
  date: string;
  summary: string;
  significance?: number;
  unresolved?: string[];
  sourceRanges?: string[];
  emotionalContext?: {
    user: string;
    yobi: string;
  };
}

export class EpisodesStore {
  constructor(private readonly paths: CompanionPaths) {}

  async listRecent(limit = 30): Promise<Episode[]> {
    const files = await this.listEpisodeFiles();
    const selected = files.sort((a, b) => b.localeCompare(a)).slice(0, Math.max(1, limit));
    const merged: Episode[] = [];
    for (const file of selected) {
      const rows = await readJsonFile<Episode[]>(path.join(this.paths.episodesDir, file), []);
      for (const row of rows) {
        const normalized = normalizeEpisode(row);
        if (normalized) {
          merged.push(normalized);
        }
      }
    }
    return merged.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  }

  async getByDate(date: string): Promise<Episode[]> {
    const targetPath = path.join(this.paths.episodesDir, `${date}.json`);
    const rows = await readJsonFile<Episode[]>(targetPath, []);
    return rows.map((row) => normalizeEpisode(row)).filter((row): row is Episode => row !== null);
  }

  async append(date: string, episode: Episode): Promise<void> {
    const targetPath = path.join(this.paths.episodesDir, `${date}.json`);
    const current = await this.getByDate(date);
    current.push(episode);
    await writeJsonFileAtomic(targetPath, current);
  }

  async saveDailyEpisodes(date: string, episodes: Episode[]): Promise<void> {
    const targetPath = path.join(this.paths.episodesDir, `${date}.json`);
    await writeJsonFileAtomic(targetPath, episodes.map((episode) => normalizeEpisode(episode)).filter((item): item is Episode => item !== null));
  }

  async clearAll(): Promise<number> {
    const files = await this.listEpisodeFiles();
    for (const file of files) {
      await fs.unlink(path.join(this.paths.episodesDir, file));
    }
    return files.length;
  }

  buildEpisode(input: EpisodeInput): Episode {
    const now = new Date().toISOString();
    const sourceRanges = [...new Set((input.sourceRanges ?? []).map((item) => item.trim()).filter(Boolean))].slice(0, 30);
    return {
      id: randomUUID(),
      date: input.date,
      summary: input.summary.trim(),
      emotional_context: {
        user_mood: input.emotionalContext?.user || "unknown",
        yobi_mood: input.emotionalContext?.yobi || "neutral"
      },
      unresolved: (input.unresolved ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 10),
      significance: clampScore(input.significance ?? 0.4),
      source_ranges: sourceRanges.length > 0 ? sourceRanges : [`day:${input.date}`],
      updated_at: now
    };
  }

  private async listEpisodeFiles(): Promise<string[]> {
    const indexPath = this.paths.episodesDir;
    if (!(await fileExists(indexPath))) {
      return [];
    }

    const entries = await import("node:fs/promises").then((fs) => fs.readdir(indexPath));
    return entries.filter((entry) => /^\d{4}-\d{2}-\d{2}\.json$/.test(entry));
  }
}

function normalizeEpisode(raw: Episode): Episode | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const date = typeof raw.date === "string" ? raw.date.trim() : "";
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (!date || !summary) {
    return null;
  }
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : randomUUID(),
    date,
    summary,
    emotional_context: {
      user_mood:
        typeof raw.emotional_context?.user_mood === "string" ? raw.emotional_context.user_mood : "unknown",
      yobi_mood:
        typeof raw.emotional_context?.yobi_mood === "string" ? raw.emotional_context.yobi_mood : "neutral"
    },
    unresolved: Array.isArray(raw.unresolved)
      ? raw.unresolved.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean).slice(0, 10)
      : [],
    significance: clampScore(raw.significance),
    source_ranges: Array.isArray(raw.source_ranges)
      ? raw.source_ranges
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .filter(Boolean)
          .slice(0, 30)
      : [],
    updated_at:
      typeof raw.updated_at === "string" && Number.isFinite(new Date(raw.updated_at).getTime())
        ? new Date(raw.updated_at).toISOString()
        : new Date().toISOString()
  };
}

function clampScore(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0.4;
  }
  return Math.max(0, Math.min(1, value));
}
