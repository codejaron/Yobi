import { CompanionPaths } from "@main/storage/paths";
import { readJsonFile, writeJsonFile } from "@main/storage/fs";
import type { BrowseAutoFollowRecord, BrowseStatus } from "@shared/types";
import type {
  BilibiliBrowseState,
  BrowseCandidateSignal,
  BrowseSyncHistoryEntry,
  FeedSnapshot,
  HotlistSnapshot
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const DEFAULT_STATE: BilibiliBrowseState = {
  authState: "missing",
  pausedReason: null,
  lastNavCheckAt: null,
  lastSyncAt: null,
  preferenceFactCount: 0,
  recentFactCount: 0,
  lastAutoFollowAt: null,
  autoFollowTodayDate: "",
  autoFollowTodayCount: 0,
  recentAutoFollows: [],
  syncHistory: [],
  candidateSignals: [],
  knownFollowedMids: [],
  qrSession: null
};

interface WatchedDocument {
  ids: string[];
}

function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function normalizeAutoFollowLog(value: unknown): BrowseAutoFollowRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const followedAt = normalizeTimestamp(raw.followedAt);
  const upMid = typeof raw.upMid === "string" ? raw.upMid.trim() : "";
  const upName = typeof raw.upName === "string" ? raw.upName.trim() : "";
  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  const accountUrl = typeof raw.accountUrl === "string" ? raw.accountUrl.trim() : "";
  if (!followedAt || !upMid || !upName || !reason || !accountUrl) {
    return null;
  }
  return {
    followedAt,
    upMid,
    upName,
    reason,
    accountUrl
  };
}

function normalizeSyncHistory(value: unknown): BrowseSyncHistoryEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const threshold = Date.now() - 2 * DAY_MS;
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const raw = entry as Record<string, unknown>;
      const syncedAt = normalizeTimestamp(raw.syncedAt);
      if (!syncedAt || new Date(syncedAt).getTime() < threshold) {
        return null;
      }
      return {
        syncedAt,
        selectedFeedCount:
          typeof raw.selectedFeedCount === "number" && Number.isFinite(raw.selectedFeedCount)
            ? Math.max(0, Math.floor(raw.selectedFeedCount))
            : 0
      } satisfies BrowseSyncHistoryEntry;
    })
    .filter((entry): entry is BrowseSyncHistoryEntry => entry !== null)
    .slice(-24);
}

function normalizeCandidateSignals(value: unknown): BrowseCandidateSignal[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const threshold = Date.now() - WEEK_MS;
  const signals: BrowseCandidateSignal[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const raw = entry as Record<string, unknown>;
    const ownerMid = typeof raw.ownerMid === "string" ? raw.ownerMid.trim() : "";
    const ownerName = typeof raw.ownerName === "string" ? raw.ownerName.trim() : "";
    if (!ownerMid || !ownerName) {
      continue;
    }

    const syncKeys = Array.isArray(raw.syncKeys)
      ? [...new Set(raw.syncKeys.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean))].slice(-16)
      : [];
    const searchKeywords = Array.isArray(raw.searchKeywords)
      ? [...new Set(raw.searchKeywords.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean))].slice(0, 12)
      : [];
    const videos = Array.isArray(raw.videos)
      ? raw.videos
          .map((video) => {
            if (!video || typeof video !== "object") {
              return null;
            }
            const next = video as Record<string, unknown>;
            const bvid = typeof next.bvid === "string" ? next.bvid.trim() : "";
            const seenAt = normalizeTimestamp(next.seenAt);
            const source = next.source === "search" ? "search" : next.source === "hot" ? "hot" : null;
            if (!bvid || !seenAt || !source || new Date(seenAt).getTime() < threshold) {
              return null;
            }
            return {
              bvid,
              seenAt,
              source
            } as BrowseCandidateSignal["videos"][number];
          })
          .filter((video): video is BrowseCandidateSignal["videos"][number] => video !== null)
          .slice(-30)
      : [];

    if (syncKeys.length === 0 || videos.length === 0) {
      continue;
    }

    signals.push({
      ownerMid,
      ownerName,
      syncKeys,
      searchKeywords,
      videos
    });
  }

  return signals.slice(-80);
}

function normalizeState(value: unknown): BilibiliBrowseState {
  if (!value || typeof value !== "object") {
    return {
      ...DEFAULT_STATE,
      autoFollowTodayDate: localDateKey()
    };
  }

  const raw = value as Record<string, unknown>;
  const authState =
    raw.authState === "active" ||
    raw.authState === "pending" ||
    raw.authState === "expired" ||
    raw.authState === "error" ||
    raw.authState === "missing"
      ? raw.authState
      : DEFAULT_STATE.authState;

  const qrSessionRaw = raw.qrSession;
  const qrSession =
    qrSessionRaw && typeof qrSessionRaw === "object"
      ? {
          qrcodeKey: typeof (qrSessionRaw as Record<string, unknown>).qrcodeKey === "string"
            ? ((qrSessionRaw as Record<string, unknown>).qrcodeKey as string).trim()
            : "",
          scanUrl: typeof (qrSessionRaw as Record<string, unknown>).scanUrl === "string"
            ? ((qrSessionRaw as Record<string, unknown>).scanUrl as string).trim()
            : "",
          expiresAt: normalizeTimestamp((qrSessionRaw as Record<string, unknown>).expiresAt),
          startedAt: normalizeTimestamp((qrSessionRaw as Record<string, unknown>).startedAt)
        }
      : null;

  const recentAutoFollows = Array.isArray(raw.recentAutoFollows)
    ? raw.recentAutoFollows.map(normalizeAutoFollowLog).filter((entry): entry is BrowseAutoFollowRecord => entry !== null).slice(-100)
    : [];
  const lastCollectAt = normalizeTimestamp(raw.lastCollectAt);
  const lastDigestAt = normalizeTimestamp(raw.lastDigestAt);
  const lastSyncAt = normalizeTimestamp(raw.lastSyncAt) ?? lastDigestAt ?? lastCollectAt;

  return {
    authState,
    pausedReason:
      typeof raw.pausedReason === "string" && raw.pausedReason.trim() ? raw.pausedReason.trim() : null,
    lastNavCheckAt: normalizeTimestamp(raw.lastNavCheckAt),
    lastSyncAt,
    preferenceFactCount:
      typeof raw.preferenceFactCount === "number" && Number.isFinite(raw.preferenceFactCount)
        ? Math.max(0, Math.floor(raw.preferenceFactCount))
        : 0,
    recentFactCount:
      typeof raw.recentFactCount === "number" && Number.isFinite(raw.recentFactCount)
        ? Math.max(0, Math.floor(raw.recentFactCount))
        : 0,
    lastAutoFollowAt: normalizeTimestamp(raw.lastAutoFollowAt),
    autoFollowTodayDate:
      typeof raw.autoFollowTodayDate === "string" && raw.autoFollowTodayDate.trim().length > 0
        ? raw.autoFollowTodayDate.trim()
        : localDateKey(),
    autoFollowTodayCount:
      typeof raw.autoFollowTodayCount === "number" && Number.isFinite(raw.autoFollowTodayCount)
        ? Math.max(0, Math.floor(raw.autoFollowTodayCount))
        : 0,
    recentAutoFollows,
    syncHistory: normalizeSyncHistory(raw.syncHistory),
    candidateSignals: normalizeCandidateSignals(raw.candidateSignals),
    knownFollowedMids: Array.isArray(raw.knownFollowedMids)
      ? [...new Set(raw.knownFollowedMids.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean))].slice(-120)
      : [],
    qrSession:
      qrSession && qrSession.qrcodeKey && qrSession.scanUrl && qrSession.expiresAt && qrSession.startedAt
        ? {
            qrcodeKey: qrSession.qrcodeKey,
            scanUrl: qrSession.scanUrl,
            expiresAt: qrSession.expiresAt,
            startedAt: qrSession.startedAt
          }
        : null
  };
}

function normalizeWatched(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const ids = (value as WatchedDocument).ids;
  if (!Array.isArray(ids)) {
    return [];
  }

  const deduped = new Set<string>();
  for (const item of ids) {
    if (typeof item !== "string") {
      continue;
    }
    const id = item.trim();
    if (!id) {
      continue;
    }
    deduped.add(id);
    if (deduped.size >= 2000) {
      break;
    }
  }

  return [...deduped];
}

export class BrowseStore {
  private state: BilibiliBrowseState | null = null;

  constructor(private readonly paths: CompanionPaths) {}

  async getState(): Promise<BilibiliBrowseState> {
    if (this.state) {
      return {
        ...this.state,
        recentAutoFollows: this.state.recentAutoFollows.map((entry) => ({ ...entry })),
        syncHistory: this.state.syncHistory.map((entry) => ({ ...entry })),
        candidateSignals: this.state.candidateSignals.map((entry) => ({
          ...entry,
          syncKeys: [...entry.syncKeys],
          searchKeywords: [...entry.searchKeywords],
          videos: entry.videos.map((video) => ({ ...video }))
        })),
        knownFollowedMids: [...this.state.knownFollowedMids],
        qrSession: this.state.qrSession ? { ...this.state.qrSession } : null
      };
    }

    const raw = await readJsonFile<unknown>(this.paths.bilibiliBrowseStatePath, null);
    this.state = normalizeState(raw);
    this.rolloverDailyCounters(this.state);
    await this.persistState();
    return this.getState();
  }

  async updateState(mutator: (state: BilibiliBrowseState) => BilibiliBrowseState): Promise<BilibiliBrowseState> {
    const current = await this.getState();
    const next = normalizeState(mutator(current));
    this.rolloverDailyCounters(next);
    this.state = next;
    await this.persistState();
    return this.getState();
  }

  async setAuthState(authState: BilibiliBrowseState["authState"], pausedReason: string | null): Promise<void> {
    await this.updateState((state) => ({
      ...state,
      authState,
      pausedReason
    }));
  }

  async setLastNavCheck(): Promise<void> {
    await this.updateState((state) => ({
      ...state,
      lastNavCheckAt: new Date().toISOString()
    }));
  }

  async setSyncSummary(input: {
    preferenceFactCount: number;
    recentFactCount: number;
    selectedFeedCount: number;
  }): Promise<void> {
    const nowIso = new Date().toISOString();
    await this.updateState((state) => ({
      ...state,
      lastSyncAt: nowIso,
      preferenceFactCount: Math.max(0, Math.floor(input.preferenceFactCount)),
      recentFactCount: Math.max(0, Math.floor(input.recentFactCount)),
      syncHistory: [
        ...state.syncHistory,
        {
          syncedAt: nowIso,
          selectedFeedCount: Math.max(0, Math.floor(input.selectedFeedCount))
        }
      ].slice(-24)
    }));
  }

  async setFactCounts(input: { preferenceFactCount: number; recentFactCount: number }): Promise<void> {
    await this.updateState((state) => ({
      ...state,
      preferenceFactCount: Math.max(0, Math.floor(input.preferenceFactCount)),
      recentFactCount: Math.max(0, Math.floor(input.recentFactCount))
    }));
  }

  async recordAutoFollow(entry: BrowseAutoFollowRecord): Promise<void> {
    await this.updateState((state) => ({
      ...state,
      lastAutoFollowAt: entry.followedAt,
      autoFollowTodayCount: state.autoFollowTodayCount + 1,
      recentAutoFollows: [...state.recentAutoFollows, entry].slice(-100)
    }));
  }

  async mergeCandidateSignals(input: {
    syncKey: string;
    seenAt: string;
    entries: Array<{
      ownerMid: string;
      ownerName: string;
      bvid: string;
      source: "hot" | "search";
      keyword?: string;
    }>;
  }): Promise<void> {
    if (input.entries.length === 0) {
      return;
    }

    await this.updateState((state) => {
      const merged = new Map<string, BrowseCandidateSignal>();
      for (const current of state.candidateSignals) {
        merged.set(current.ownerMid, {
          ...current,
          syncKeys: [...current.syncKeys],
          searchKeywords: [...current.searchKeywords],
          videos: current.videos.map((video) => ({ ...video }))
        });
      }

      for (const entry of input.entries) {
        const current =
          merged.get(entry.ownerMid) ?? {
            ownerMid: entry.ownerMid,
            ownerName: entry.ownerName,
            syncKeys: [],
            searchKeywords: [],
            videos: []
          };
        current.ownerName = entry.ownerName;
        if (!current.syncKeys.includes(input.syncKey)) {
          current.syncKeys.push(input.syncKey);
        }
        if (entry.keyword && !current.searchKeywords.includes(entry.keyword)) {
          current.searchKeywords.push(entry.keyword);
        }
        const existingVideo = current.videos.find((video) => video.bvid === entry.bvid);
        if (existingVideo) {
          existingVideo.seenAt = input.seenAt;
          existingVideo.source = entry.source;
        } else {
          current.videos.push({
            bvid: entry.bvid,
            seenAt: input.seenAt,
            source: entry.source
          });
        }
        merged.set(entry.ownerMid, current);
      }

      return {
        ...state,
        candidateSignals: [...merged.values()]
      };
    });
  }

  async clearManagedMetadata(): Promise<void> {
    await this.updateState((state) => ({
      ...state,
      preferenceFactCount: 0,
      recentFactCount: 0,
      syncHistory: [],
      candidateSignals: []
    }));
  }

  async saveFeed(snapshot: FeedSnapshot): Promise<void> {
    await writeJsonFile(this.paths.bilibiliFeedPath, snapshot);
  }

  async saveHotlist(snapshot: HotlistSnapshot): Promise<void> {
    await writeJsonFile(this.paths.bilibiliHotlistPath, snapshot);
  }

  async loadFeed(): Promise<FeedSnapshot> {
    const fallback: FeedSnapshot = {
      fetchedAt: new Date(0).toISOString(),
      items: []
    };
    const raw = await readJsonFile<FeedSnapshot>(this.paths.bilibiliFeedPath, fallback);
    return {
      fetchedAt: normalizeTimestamp(raw.fetchedAt) ?? fallback.fetchedAt,
      items: Array.isArray(raw.items) ? raw.items : []
    };
  }

  async loadHotlist(): Promise<HotlistSnapshot> {
    const fallback: HotlistSnapshot = {
      fetchedAt: new Date(0).toISOString(),
      items: []
    };
    const raw = await readJsonFile<HotlistSnapshot>(this.paths.bilibiliHotlistPath, fallback);
    return {
      fetchedAt: normalizeTimestamp(raw.fetchedAt) ?? fallback.fetchedAt,
      items: Array.isArray(raw.items) ? raw.items : []
    };
  }

  async loadWatched(): Promise<Set<string>> {
    const raw = await readJsonFile<unknown>(this.paths.bilibiliWatchedPath, {
      ids: []
    });

    return new Set(normalizeWatched(raw));
  }

  async saveWatched(watched: Set<string>): Promise<void> {
    const ids = [...watched].slice(-2000);
    await writeJsonFile<WatchedDocument>(this.paths.bilibiliWatchedPath, {
      ids
    });
  }

  async getStatus(): Promise<BrowseStatus> {
    const state = await this.getState();
    return {
      authState: state.authState,
      lastNavCheckAt: state.lastNavCheckAt,
      lastSyncAt: state.lastSyncAt,
      preferenceFactCount: state.preferenceFactCount,
      recentFactCount: state.recentFactCount,
      lastAutoFollowAt: state.lastAutoFollowAt,
      autoFollowTodayCount: state.autoFollowTodayCount,
      recentAutoFollows: state.recentAutoFollows.map((entry) => ({ ...entry })),
      pausedReason: state.pausedReason
    };
  }

  async markKnownFollowed(mid: string): Promise<void> {
    const value = mid.trim();
    if (!value) {
      return;
    }
    await this.updateState((state) => ({
      ...state,
      knownFollowedMids: [...new Set([...state.knownFollowedMids, value])].slice(-120)
    }));
  }

  private rolloverDailyCounters(state: BilibiliBrowseState): void {
    const today = localDateKey();
    if (state.autoFollowTodayDate === today) {
      return;
    }

    state.autoFollowTodayDate = today;
    state.autoFollowTodayCount = 0;
  }

  private async persistState(): Promise<void> {
    if (!this.state) {
      return;
    }
    await writeJsonFile(this.paths.bilibiliBrowseStatePath, this.state);
  }
}
