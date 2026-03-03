import { CompanionPaths } from "@main/storage/paths";
import { readJsonFile, writeJsonFile } from "@main/storage/fs";
import type { BrowseStatus } from "@shared/types";
import type {
  BilibiliBrowseState,
  FeedSnapshot,
  HotlistSnapshot
} from "./types";

const DEFAULT_STATE: BilibiliBrowseState = {
  authState: "missing",
  pausedReason: null,
  lastNavCheckAt: null,
  lastCollectAt: null,
  lastDigestAt: null,
  todayDate: "",
  todayTokenUsed: 0,
  todayEventShares: 0,
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

  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(parsed).toISOString();
}

function normalizeState(value: unknown): BilibiliBrowseState {
  if (!value || typeof value !== "object") {
    return {
      ...DEFAULT_STATE,
      todayDate: localDateKey()
    };
  }

  const raw = value as Record<string, unknown>;
  const authState =
    raw.authState === "missing" ||
    raw.authState === "pending" ||
    raw.authState === "active" ||
    raw.authState === "expired" ||
    raw.authState === "error"
      ? raw.authState
      : "missing";

  const qrSessionRaw = raw.qrSession;
  const qrSession =
    qrSessionRaw && typeof qrSessionRaw === "object"
      ? (() => {
          const session = qrSessionRaw as Record<string, unknown>;
          const qrcodeKey = typeof session.qrcodeKey === "string" ? session.qrcodeKey.trim() : "";
          const scanUrl = typeof session.scanUrl === "string" ? session.scanUrl.trim() : "";
          const expiresAt = normalizeTimestamp(session.expiresAt);
          const startedAt = normalizeTimestamp(session.startedAt);
          if (!qrcodeKey || !scanUrl || !expiresAt || !startedAt) {
            return null;
          }

          return {
            qrcodeKey,
            scanUrl,
            expiresAt,
            startedAt
          };
        })()
      : null;

  return {
    authState,
    pausedReason:
      typeof raw.pausedReason === "string" && raw.pausedReason.trim() ? raw.pausedReason.trim() : null,
    lastNavCheckAt: normalizeTimestamp(raw.lastNavCheckAt),
    lastCollectAt: normalizeTimestamp(raw.lastCollectAt),
    lastDigestAt: normalizeTimestamp(raw.lastDigestAt),
    todayDate:
      typeof raw.todayDate === "string" && raw.todayDate.trim().length > 0
        ? raw.todayDate.trim()
        : localDateKey(),
    todayTokenUsed:
      typeof raw.todayTokenUsed === "number" && Number.isFinite(raw.todayTokenUsed)
        ? Math.max(0, Math.floor(raw.todayTokenUsed))
        : 0,
    todayEventShares:
      typeof raw.todayEventShares === "number" && Number.isFinite(raw.todayEventShares)
        ? Math.max(0, Math.floor(raw.todayEventShares))
        : 0,
    qrSession
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
        qrSession: this.state.qrSession ? { ...this.state.qrSession } : null
      };
    }

    const raw = await readJsonFile<unknown>(this.paths.bilibiliBrowseStatePath, null);
    this.state = normalizeState(raw);
    this.rolloverDailyCounters(this.state);
    await this.persistState();
    return {
      ...this.state,
      qrSession: this.state.qrSession ? { ...this.state.qrSession } : null
    };
  }

  async updateState(mutator: (state: BilibiliBrowseState) => BilibiliBrowseState): Promise<BilibiliBrowseState> {
    const current = await this.getState();
    const next = normalizeState(mutator(current));
    this.rolloverDailyCounters(next);
    this.state = next;
    await this.persistState();
    return {
      ...next,
      qrSession: next.qrSession ? { ...next.qrSession } : null
    };
  }

  async setAuthState(authState: BilibiliBrowseState["authState"], pausedReason: string | null): Promise<void> {
    await this.updateState((state) => ({
      ...state,
      authState,
      pausedReason
    }));
  }

  async consumeEventShare(limit: number): Promise<boolean> {
    let consumed = false;
    await this.updateState((state) => {
      if (state.todayEventShares >= limit) {
        return state;
      }

      consumed = true;
      return {
        ...state,
        todayEventShares: state.todayEventShares + 1
      };
    });

    return consumed;
  }

  async addTokenUsed(delta: number): Promise<void> {
    if (!Number.isFinite(delta) || delta <= 0) {
      return;
    }

    await this.updateState((state) => ({
      ...state,
      todayTokenUsed: state.todayTokenUsed + Math.floor(delta)
    }));
  }

  async setLastNavCheck(): Promise<void> {
    await this.updateState((state) => ({
      ...state,
      lastNavCheckAt: new Date().toISOString()
    }));
  }

  async setLastCollect(): Promise<void> {
    await this.updateState((state) => ({
      ...state,
      lastCollectAt: new Date().toISOString()
    }));
  }

  async setLastDigest(): Promise<void> {
    await this.updateState((state) => ({
      ...state,
      lastDigestAt: new Date().toISOString()
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
      lastCollectAt: state.lastCollectAt,
      lastDigestAt: state.lastDigestAt,
      todayTokenUsed: state.todayTokenUsed,
      todayEventShares: state.todayEventShares,
      pausedReason: state.pausedReason
    };
  }

  private rolloverDailyCounters(state: BilibiliBrowseState): void {
    const today = localDateKey();
    if (state.todayDate === today) {
      return;
    }

    state.todayDate = today;
    state.todayTokenUsed = 0;
    state.todayEventShares = 0;
  }

  private async persistState(): Promise<void> {
    if (!this.state) {
      return;
    }
    await writeJsonFile(this.paths.bilibiliBrowseStatePath, this.state);
  }
}
