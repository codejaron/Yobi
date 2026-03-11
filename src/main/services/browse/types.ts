import type { BrowseAuthState, BrowseAutoFollowRecord } from "@shared/types";

export interface BilibiliVideoItem {
  bvid: string;
  aid?: number;
  cid?: number;
  title: string;
  ownerName: string;
  ownerMid?: string;
  cover?: string;
  description?: string;
  tags: string[];
  source: "feed" | "hot" | "search";
  view?: number;
  durationSec?: number;
  like?: number;
  pubTs?: number;
  dynamicId?: string;
  url: string;
}

export interface FeedSnapshot {
  fetchedAt: string;
  items: BilibiliVideoItem[];
}

export interface HotlistSnapshot {
  fetchedAt: string;
  items: BilibiliVideoItem[];
}

export interface BrowseSyncHistoryEntry {
  syncedAt: string;
  selectedFeedCount: number;
}

export interface BrowseCandidateSignal {
  ownerMid: string;
  ownerName: string;
  syncKeys: string[];
  searchKeywords: string[];
  videos: Array<{
    bvid: string;
    seenAt: string;
    source: "hot" | "search";
  }>;
}

export interface BilibiliBrowseState {
  authState: BrowseAuthState;
  pausedReason: string | null;
  lastNavCheckAt: string | null;
  lastSyncAt: string | null;
  preferenceFactCount: number;
  recentFactCount: number;
  lastAutoFollowAt: string | null;
  autoFollowTodayDate: string;
  autoFollowTodayCount: number;
  recentAutoFollows: BrowseAutoFollowRecord[];
  syncHistory: BrowseSyncHistoryEntry[];
  candidateSignals: BrowseCandidateSignal[];
  knownFollowedMids: string[];
  qrSession:
    | {
        qrcodeKey: string;
        scanUrl: string;
        expiresAt: string;
        startedAt: string;
      }
    | null;
}
