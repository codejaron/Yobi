import type { Episode } from "@shared/types";

export function countMeaningfulDays(episodes: Episode[]): number {
  const meaningfulDates = new Set(
    episodes.filter((episode) => episode.significance >= 0.6).map((episode) => episode.date)
  );
  return meaningfulDates.size;
}

export function computeAverageEpisodeQuality(episodes: Episode[]): number {
  if (episodes.length === 0) {
    return 0;
  }
  return episodes.reduce((sum, episode) => sum + episode.significance, 0) / episodes.length;
}

export function toDayKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function shorten(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 1)}…`;
}

export function isWithinQuietHours(
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

export function computeTargetStage(
  historyCount: number,
  connection: number,
  meaningfulDays7d: number,
  recentEpisodeQuality7d: number
): "stranger" | "acquaintance" | "familiar" | "close" | "intimate" {
  if (connection >= 0.82 && meaningfulDays7d >= 5 && recentEpisodeQuality7d >= 0.75) {
    return "intimate";
  }
  if (connection >= 0.68 && meaningfulDays7d >= 4) {
    return "close";
  }
  if (connection >= 0.52 && meaningfulDays7d >= 2) {
    return "familiar";
  }
  if (connection >= 0.35 || historyCount >= 30) {
    return "acquaintance";
  }
  return "stranger";
}
