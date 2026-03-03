import type { BrowseTopicMaterial } from "@shared/types";
import type { DigestInputCandidate } from "./types";

function compactText(value: string, max = 140): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, max - 1)).trim()}...`;
}

function uniqueTags(tags: string[]): string[] {
  const deduped = new Set<string>();
  for (const tag of tags) {
    const value = tag.trim();
    if (!value) {
      continue;
    }
    deduped.add(value);
    if (deduped.size >= 12) {
      break;
    }
  }
  return [...deduped];
}

function formatDuration(seconds: number | undefined): string | undefined {
  if (!Number.isFinite(seconds) || !seconds || seconds <= 0) {
    return undefined;
  }

  const safe = Math.floor(seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function toPublishedAt(pubTs: number | undefined): string | undefined {
  if (!Number.isFinite(pubTs) || !pubTs || pubTs <= 0) {
    return undefined;
  }
  return new Date(pubTs * 1000).toISOString();
}

function buildPreview(material: BrowseTopicMaterial): string {
  return `${material.up}：${material.title}`.replace(/\s+/g, " ").trim();
}

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

export class DigestGenerator {
  build(input: {
    candidates: DigestInputCandidate[];
    maxItems: number;
  }): Array<{
    bvid: string;
    source: "browse:event" | "browse:digest";
    expiresAt: string;
    previewText: string;
    material: BrowseTopicMaterial;
  }> {
    const maxItems = Math.max(1, Math.min(10, input.maxItems));
    const items = input.candidates.slice(0, maxItems);
    if (items.length === 0) {
      return [];
    }

    return items.map((candidate) => {
      const detail = candidate.detail;
      const material: BrowseTopicMaterial = {
        bvid: candidate.item.bvid,
        title: compactText(candidate.item.title, 120),
        up: compactText(candidate.item.ownerName, 40),
        tags: uniqueTags([...(candidate.item.tags ?? []), ...(detail?.tags ?? [])]),
        plays: Number.isFinite(candidate.item.view) ? Math.floor(candidate.item.view ?? 0) : undefined,
        duration: formatDuration(detail?.durationSec ?? candidate.item.durationSec),
        publishedAt: toPublishedAt(detail?.pubTs ?? candidate.item.pubTs),
        desc: compactText(detail?.desc || candidate.item.description || "", 220) || undefined,
        topComments: (candidate.topComments ?? []).slice(0, 5),
        url: candidate.item.url
      };

      return {
        bvid: candidate.item.bvid,
        source: candidate.isEvent ? "browse:event" : "browse:digest",
        expiresAt: hoursFromNow(candidate.isEvent ? 24 : 48),
        previewText: buildPreview(material),
        material
      };
    });
  }
}
