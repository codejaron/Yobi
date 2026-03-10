import type { AppConfig, BrowseAutoFollowRecord, BrowseStatus } from "@shared/types";
import { openSafeWebUrl } from "@main/utils/external-links";
import type { YobiMemory } from "@main/memory/setup";
import { appLogger as logger } from "@main/runtime/singletons";
import { CompanionPaths } from "@main/storage/paths";
import { BrowseStore } from "./browse-store";
import {
  BilibiliAuthService,
  normalizeCookieString,
  type QrPollResult,
  type QrStartResult
} from "./bilibili-auth";
import { BilibiliCollector } from "./bilibili-collector";
import { canAutoFollowCandidate, describeAutoFollowReason, selectSyncItems, type AutoFollowLimits } from "./sync-logic";
import type { BilibiliVideoItem } from "./types";

const MANAGED_SOURCE = "browse:bilibili";
const MANAGED_ENTITY = "Yobi";
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETRY_DELAY_MS = 30 * 60 * 1000;
const AUTO_FOLLOW_LIMITS: AutoFollowLimits = {
  minIntervalMs: 12 * 60 * 60 * 1000,
  maxPerDay: 2,
  maxPerWeek: 8,
  maxTotal: 80
};
const BLOCKED_KEYWORD_FRAGMENTS = ["热门", "综合", "视频", "推荐", "首页", "搜索结果"];

export { SYNC_INTERVAL_MS as BILIBILI_SYNC_INTERVAL_MS, RETRY_DELAY_MS as BILIBILI_SYNC_RETRY_DELAY_MS };

export interface BrowseSyncOutcome {
  ran: boolean;
  changed: boolean;
  reason: "disabled" | "missing-cookie" | "auth-expired" | "synced" | "no-content" | "error" | "auth-error";
  detail?: string;
  nextDelayMs: number | null;
}

function cookieValue(cookie: string, key: string): string {
  const entries = cookie
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const currentKey = entry.slice(0, separator).trim();
    if (currentKey !== key) {
      continue;
    }
    return entry.slice(separator + 1).trim();
  }
  return "";
}

function uniq(values: string[], limit = 12): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value) {
      continue;
    }
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(value);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function buildAccountUrl(mid: string): string {
  const target = mid.trim();
  return target ? `https://space.bilibili.com/${encodeURIComponent(target)}` : "https://www.bilibili.com";
}

function topNames(items: BilibiliVideoItem[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = item.ownerName.trim();
    if (!name) {
      continue;
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([value]) => value);
}

function topTags(items: BilibiliVideoItem[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tag of item.tags) {
      const value = tag.trim();
      if (!value) {
        continue;
      }
      if (BLOCKED_KEYWORD_FRAGMENTS.some((entry) => value.includes(entry))) {
        continue;
      }
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([value]) => value);
}

function buildPreferenceFacts(items: BilibiliVideoItem[]): Array<{
  entity: string;
  key: string;
  value: string;
  category: "preference";
  confidence: number;
  ttl_class: "stable";
  source: string;
  source_range?: string;
}> {
  const facts: Array<{
    entity: string;
    key: string;
    value: string;
    category: "preference";
    confidence: number;
    ttl_class: "stable";
    source: string;
    source_range?: string;
  }> = [];
  const owners = topNames(items, 3);
  const tags = topTags(items, 5);

  if (owners.length > 0) {
    facts.push({
      entity: MANAGED_ENTITY,
      key: "bilibili.preference.ups",
      value: `最近常看 UP：${owners.join("、")}`,
      category: "preference",
      confidence: 0.78,
      ttl_class: "stable",
      source: MANAGED_SOURCE
    });
  }

  if (tags.length > 0) {
    facts.push({
      entity: MANAGED_ENTITY,
      key: "bilibili.preference.tags",
      value: `最近偏好的内容方向：${tags.join("、")}`,
      category: "preference",
      confidence: 0.72,
      ttl_class: "stable",
      source: MANAGED_SOURCE
    });
  }

  return facts;
}

function buildRecentFacts(items: BilibiliVideoItem[]): Array<{
  entity: string;
  key: string;
  value: string;
  category: "event";
  confidence: number;
  ttl_class: "active";
  source: string;
  source_range?: string;
}> {
  return items.slice(0, 5).map((item, index) => ({
    entity: MANAGED_ENTITY,
    key: `bilibili.recent.${index + 1}`,
    value: `最近在看《${item.title}》by ${item.ownerName}${item.tags.length > 0 ? `，内容偏向 ${item.tags.slice(0, 3).join("、")}` : ""}`,
    category: "event",
    confidence: 0.7,
    ttl_class: "active",
    source: MANAGED_SOURCE,
    source_range: item.bvid
  }));
}

function buildAutoFollowFact(record: BrowseAutoFollowRecord): {
  entity: string;
  key: string;
  value: string;
  category: "event";
  confidence: number;
  ttl_class: "active";
  source: string;
  source_range?: string;
} {
  return {
    entity: MANAGED_ENTITY,
    key: "bilibili.recent.follow",
    value: `最近决定关注 ${record.upName}，原因：${record.reason}`,
    category: "event",
    confidence: 0.8,
    ttl_class: "active",
    source: MANAGED_SOURCE,
    source_range: `follow:${record.upMid}`
  };
}

function extractPreferenceKeywords(items: BilibiliVideoItem[]): string[] {
  return uniq([
    ...topTags(items, 4),
    ...topNames(items, 2)
  ]).slice(0, 4);
}

export class BilibiliBrowseService {
  private readonly store: BrowseStore;
  private readonly authService: BilibiliAuthService;
  private readonly collector: BilibiliCollector;

  constructor(
    paths: CompanionPaths,
    private readonly memory: YobiMemory,
    private readonly getConfig: () => AppConfig,
    private readonly persistCookie: (cookie: string) => Promise<void>
  ) {
    this.store = new BrowseStore(paths);
    this.authService = new BilibiliAuthService(this.store);
    this.collector = new BilibiliCollector();
  }

  async getStatus(): Promise<BrowseStatus> {
    const status = await this.store.getStatus();
    const cookie = this.getConfig().browse.bilibiliCookie.trim();

    if (!cookie && status.authState !== "pending") {
      return {
        ...status,
        authState: "missing",
        pausedReason: status.pausedReason ?? "未配置 B 站登录"
      };
    }

    return status;
  }

  async startQrAuth(): Promise<QrStartResult> {
    return this.authService.startQrAuth();
  }

  async pollQrAuth(input: { qrcodeKey: string }): Promise<QrPollResult> {
    const result = await this.authService.pollQrAuth(input.qrcodeKey);
    if (!result.cookieSaved || !result.cookie) {
      return result;
    }

    await this.persistCookie(result.cookie);
    await this.store.setAuthState("active", null);

    return {
      ...result,
      cookieSaved: true
    };
  }

  async saveCookie(input: { cookie: string }): Promise<{
    saved: boolean;
    message: string;
    authState: BrowseStatus["authState"];
  }> {
    const cookie = normalizeCookieString(input.cookie);
    if (!cookie) {
      await this.persistCookie("");
      await this.clearManagedContent();
      await this.store.setAuthState("missing", "未配置 B 站登录");
      return {
        saved: false,
        message: "Cookie 为空，已清空配置。",
        authState: "missing"
      };
    }

    await this.persistCookie(cookie);
    await this.store.setAuthState("active", null);
    return {
      saved: true,
      message: "已保存 B 站 Cookie。",
      authState: "active"
    };
  }

  async clearManagedContent(): Promise<void> {
    await Promise.all([
      this.memory.getFactsStore().removeBySource({
        source: MANAGED_SOURCE,
        entity: MANAGED_ENTITY
      }),
      this.memory.clearTopicsBySourcePrefixes(["browse:"])
    ]);
    await this.store.clearManagedMetadata();
  }

  async ensureManagedStateMatchesConfig(): Promise<void> {
    const config = this.getConfig();
    const cookie = config.browse.bilibiliCookie.trim();
    if (config.browse.enabled && cookie) {
      return;
    }
    await this.clearManagedContent();
    await this.store.setAuthState("missing", config.browse.enabled ? "未配置 B 站 Cookie" : "浏览同步已关闭");
  }

  async runSync(): Promise<BrowseSyncOutcome> {
    const config = this.getConfig();
    if (!config.browse.enabled) {
      await this.clearManagedContent();
      await this.store.setAuthState("missing", "浏览同步已关闭");
      return {
        ran: false,
        changed: true,
        reason: "disabled",
        nextDelayMs: null
      };
    }

    const cookie = config.browse.bilibiliCookie.trim();
    if (!cookie) {
      await this.clearManagedContent();
      await this.store.setAuthState("missing", "未配置 B 站 Cookie");
      return {
        ran: false,
        changed: true,
        reason: "missing-cookie",
        nextDelayMs: null
      };
    }

    let nav: Awaited<ReturnType<BilibiliCollector["checkLogin"]>>;
    try {
      nav = await this.collector.checkLogin(cookie);
      await this.store.setLastNavCheck();
      await this.store.setAuthState(nav.isLogin ? "active" : "expired", nav.isLogin ? null : "Cookie 已失效，请重新扫码");
      if (!nav.isLogin) {
        return {
          ran: true,
          changed: false,
          reason: "auth-expired",
          detail: nav.message,
          nextDelayMs: null
        };
      }
    } catch (error) {
      await this.store.setAuthState("error", "登录状态检查失败");
      return {
        ran: true,
        changed: false,
        reason: "auth-error",
        detail: error instanceof Error ? error.message : "unknown",
        nextDelayMs: RETRY_DELAY_MS
      };
    }

    try {
      const [{ feed, hotlist }, relationStat] = await Promise.all([
        this.collector.collect(cookie),
        nav.mid ? this.collector.fetchRelationStat(cookie, nav.mid).catch(() => ({ following: 0 })) : Promise.resolve({ following: 0 })
      ]);
      await this.store.saveFeed(feed);
      await this.store.saveHotlist(hotlist);

      const selected = selectSyncItems({
        feedItems: feed.items,
        hotItems: hotlist.items,
        maxFeed: 6,
        maxHot: 4
      });
      const selectedFeedCount = selected.filter((item) => item.source === "feed").length;
      const preferenceKeywords = extractPreferenceKeywords(selected);
      const autoFollowRecord = config.browse.autoFollowEnabled
        ? await this.maybeAutoFollow({
            cookie,
            selfMid: nav.mid,
            followingCount: relationStat.following,
            hotItems: hotlist.items,
            selectedFeedCount,
            preferenceKeywords
          })
        : null;

      const preferenceFacts = buildPreferenceFacts(selected);
      const recentFacts = buildRecentFacts(selected);
      if (autoFollowRecord) {
        recentFacts.unshift(buildAutoFollowFact(autoFollowRecord));
      }

      await this.memory.getFactsStore().replaceBySource({
        source: MANAGED_SOURCE,
        entity: MANAGED_ENTITY,
        facts: [...preferenceFacts, ...recentFacts]
      });
      await this.memory.clearTopicsBySourcePrefixes(["browse:"]);
      await this.store.setSyncSummary({
        preferenceFactCount: preferenceFacts.length,
        recentFactCount: recentFacts.length,
        selectedFeedCount
      });

      return {
        ran: true,
        changed: preferenceFacts.length > 0 || recentFacts.length > 0,
        reason: preferenceFacts.length > 0 || recentFacts.length > 0 ? "synced" : "no-content",
        nextDelayMs: SYNC_INTERVAL_MS
      };
    } catch (error) {
      logger.warn("browse", "bilibili-sync-failed", undefined, error);
      return {
        ran: true,
        changed: false,
        reason: "error",
        detail: error instanceof Error ? error.message : "unknown",
        nextDelayMs: RETRY_DELAY_MS
      };
    }
  }

  async openAccountPage(): Promise<{ opened: boolean; message: string }> {
    const cookie = this.getConfig().browse.bilibiliCookie.trim();
    const mid = cookieValue(cookie, "DedeUserID");
    const url = buildAccountUrl(mid);
    const opened = await openSafeWebUrl(url);
    return {
      opened,
      message: opened ? "已打开 Yobi 的 B 站主页。" : "打开失败，请检查当前登录信息。"
    };
  }

  private async maybeAutoFollow(input: {
    cookie: string;
    selfMid: string;
    followingCount: number;
    hotItems: BilibiliVideoItem[];
    selectedFeedCount: number;
    preferenceKeywords: string[];
  }): Promise<BrowseAutoFollowRecord | null> {
    const now = Date.now();
    const state = await this.store.getState();
    const recentFeedCount = state.syncHistory
      .filter((entry) => now - new Date(entry.syncedAt).getTime() <= 24 * 60 * 60 * 1000)
      .reduce((sum, entry) => sum + entry.selectedFeedCount, 0);
    const coldStart = input.followingCount === 0 || recentFeedCount + input.selectedFeedCount < 3;
    const syncKey = new Date().toISOString();

    const signalEntries: Array<{
      ownerMid: string;
      ownerName: string;
      bvid: string;
      source: "hot" | "search";
      keyword?: string;
    }> = [];

    for (const item of input.hotItems.slice(0, 12)) {
      if (!item.ownerMid || !item.bvid || item.ownerMid === input.selfMid) {
        continue;
      }
      signalEntries.push({
        ownerMid: item.ownerMid,
        ownerName: item.ownerName,
        bvid: item.bvid,
        source: "hot"
      });
    }

    for (const keyword of input.preferenceKeywords.slice(0, 2)) {
      try {
        const videos = await this.collector.searchVideos(input.cookie, keyword, 5);
        for (const item of videos) {
          if (!item.ownerMid || !item.bvid || item.ownerMid === input.selfMid) {
            continue;
          }
          signalEntries.push({
            ownerMid: item.ownerMid,
            ownerName: item.ownerName,
            bvid: item.bvid,
            source: "search",
            keyword
          });
        }
      } catch (error) {
        logger.warn("browse", "bilibili-search-expand-failed", { keyword }, error);
      }
    }

    await this.store.mergeCandidateSignals({
      syncKey,
      seenAt: syncKey,
      entries: signalEntries
    });
    const refreshed = await this.store.getState();
    const weekFollowCount = refreshed.recentAutoFollows.filter(
      (entry) => now - new Date(entry.followedAt).getTime() <= 7 * 24 * 60 * 60 * 1000
    ).length;

    const candidates = refreshed.candidateSignals
      .filter((candidate) => !refreshed.knownFollowedMids.includes(candidate.ownerMid))
      .sort((left, right) => {
        const leftSyncs = new Set(left.syncKeys).size;
        const rightSyncs = new Set(right.syncKeys).size;
        if (rightSyncs !== leftSyncs) {
          return rightSyncs - leftSyncs;
        }
        return new Set(right.videos.map((video) => video.bvid)).size - new Set(left.videos.map((video) => video.bvid)).size;
      });

    for (const candidate of candidates) {
      if (
        !canAutoFollowCandidate({
          candidate,
          nowMs: now,
          lastAutoFollowAt: refreshed.lastAutoFollowAt,
          autoFollowTodayCount: refreshed.autoFollowTodayCount,
          weekFollowCount,
          totalFollowCount: refreshed.recentAutoFollows.length,
          limits: AUTO_FOLLOW_LIMITS
        })
      ) {
        continue;
      }

      const reason = describeAutoFollowReason({
        candidate,
        coldStart
      });

      try {
        await this.collector.followUser(input.cookie, candidate.ownerMid);
        const record: BrowseAutoFollowRecord = {
          followedAt: new Date().toISOString(),
          upMid: candidate.ownerMid,
          upName: candidate.ownerName,
          reason,
          accountUrl: buildAccountUrl(candidate.ownerMid)
        };
        await this.store.markKnownFollowed(candidate.ownerMid);
        await this.store.recordAutoFollow(record);
        return record;
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown";
        if (/已关注|重复/i.test(message)) {
          await this.store.markKnownFollowed(candidate.ownerMid);
          continue;
        }
        logger.warn("browse", "bilibili-auto-follow-failed", { mid: candidate.ownerMid, reason }, error);
        return null;
      }
    }

    return null;
  }
}
