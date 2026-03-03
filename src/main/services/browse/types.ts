import type { BrowseTopicMaterial, BrowseAuthState } from "@shared/types";

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
  source: "feed" | "hot";
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

export interface BilibiliBrowseState {
  authState: BrowseAuthState;
  pausedReason: string | null;
  lastNavCheckAt: string | null;
  lastCollectAt: string | null;
  lastDigestAt: string | null;
  todayDate: string;
  todayTokenUsed: number;
  todayEventShares: number;
  qrSession:
    | {
        qrcodeKey: string;
        scanUrl: string;
        expiresAt: string;
        startedAt: string;
      }
    | null;
}

export interface MatchedCandidate {
  item: BilibiliVideoItem;
  score: number;
  matches: string[];
  isEvent: boolean;
}

export interface DigestInputCandidate extends MatchedCandidate {
  detail?: {
    desc?: string;
    tags?: string[];
    cid?: number;
    durationSec?: number;
    pubTs?: number;
  };
  topComments?: BrowseTopicMaterial["topComments"];
}
