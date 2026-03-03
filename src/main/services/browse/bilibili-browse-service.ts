import { generateObject } from "ai";
import { z } from "zod";
import type { AppConfig, BrowseStatus, InterestProfile } from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import type { ModelFactory } from "@main/core/model-factory";
import { resolveOpenAIStoreOption } from "@main/core/provider-utils";
import type { YobiMemory } from "@main/memory/setup";
import { reportTokenUsage } from "@main/services/token/token-usage-reporter";
import {
  estimateTokensFromText,
  parseUsageTokens
} from "@main/services/token/token-usage-utils";
import { BrowseStore } from "./browse-store";
import {
  BilibiliAuthService,
  normalizeCookieString,
  type QrPollResult,
  type QrStartResult
} from "./bilibili-auth";
import { BilibiliCollector } from "./bilibili-collector";
import { InterestMatcher } from "./interest-matcher";
import { DigestGenerator } from "./digest-generator";
import { nextAuthStateFromNav } from "./rules";
import type { DigestInputCandidate, MatchedCandidate } from "./types";

const PRIMARY_RESOURCE_ID = "primary-user";
const PRIMARY_THREAD_ID = "primary-thread";

const interestSchema = z.object({
  games: z.array(z.string().min(1).max(40)).max(20).default([]),
  creators: z.array(z.string().min(1).max(40)).max(20).default([]),
  domains: z.array(z.string().min(1).max(40)).max(20).default([]),
  dislikes: z.array(z.string().min(1).max(40)).max(20).default([]),
  keywords: z.array(z.string().min(1).max(40)).max(30).default([])
});

export interface BrowseHeartbeatOutcome {
  ran: boolean;
  changed: boolean;
  reason:
    | "disabled"
    | "missing-cookie"
    | "auth-expired"
    | "no-op"
    | "added"
    | "error"
    | "paused"
    | "auth-error";
  detail?: string;
}

function uniq(items: string[]): string[] {
  const unique = new Set<string>();
  for (const item of items) {
    const value = item.trim();
    if (!value) {
      continue;
    }
    unique.add(value);
  }
  return [...unique].slice(0, 30);
}

function shouldRun(lastAt: string | null, intervalMs: number): boolean {
  if (!lastAt) {
    return true;
  }
  const last = new Date(lastAt).getTime();
  if (!Number.isFinite(last)) {
    return true;
  }
  return Date.now() - last >= intervalMs;
}

function budgetDigestInterval(config: AppConfig, status: BrowseStatus): number {
  const base = config.browse.digestIntervalMs;
  const budget = Math.max(1, config.browse.tokenBudgetDaily);
  const ratio = status.todayTokenUsed / budget;
  if (ratio >= 1) {
    return Math.max(base, 6 * 60 * 60 * 1000);
  }
  if (ratio >= 0.7) {
    return Math.max(base, 4 * 60 * 60 * 1000);
  }
  return base;
}

function normalizeInterestProfile(profile: InterestProfile): InterestProfile {
  return {
    games: uniq(profile.games),
    creators: uniq(profile.creators),
    domains: uniq(profile.domains),
    dislikes: uniq(profile.dislikes),
    keywords: uniq(profile.keywords),
    updatedAt: profile.updatedAt
  };
}

export class BilibiliBrowseService {
  private readonly store: BrowseStore;
  private readonly authService: BilibiliAuthService;
  private readonly collector: BilibiliCollector;
  private readonly matcher = new InterestMatcher();
  private readonly digestGenerator = new DigestGenerator();

  constructor(
    paths: CompanionPaths,
    private readonly modelFactory: ModelFactory,
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

  async tryConsumeEventShareQuota(): Promise<boolean> {
    const config = this.getConfig();
    return this.store.consumeEventShare(config.browse.eventDailyCap);
  }

  async runHeartbeat(input: {
    forceDigest: boolean;
  }): Promise<BrowseHeartbeatOutcome> {
    const config = this.getConfig();
    if (!config.browse.enabled) {
      await this.store.setAuthState("missing", "浏览感知已关闭");
      return {
        ran: false,
        changed: false,
        reason: "disabled"
      };
    }

    const cookie = config.browse.bilibiliCookie.trim();
    if (!cookie) {
      await this.store.setAuthState("missing", "未配置 B 站 Cookie");
      return {
        ran: true,
        changed: false,
        reason: "missing-cookie"
      };
    }

    try {
      const nav = await this.collector.checkLogin(cookie);
      await this.store.setLastNavCheck();

      const nextAuth = nextAuthStateFromNav(nav.isLogin);
      await this.store.setAuthState(nextAuth.authState, nextAuth.pausedReason);

      if (!nav.isLogin) {
        return {
          ran: true,
          changed: false,
          reason: "auth-expired",
          detail: nav.message
        };
      }
    } catch (error) {
      await this.store.setAuthState("error", "登录状态检查失败");
      return {
        ran: true,
        changed: false,
        reason: "auth-error",
        detail: error instanceof Error ? error.message : "unknown"
      };
    }

    let changed = false;
    let performed = false;
    const status = await this.store.getStatus();

    if (input.forceDigest || shouldRun(status.lastCollectAt, config.browse.collectIntervalMs)) {
      performed = true;
      const snapshots = await this.collector.collect(cookie);
      await this.store.saveFeed(snapshots.feed);
      await this.store.saveHotlist(snapshots.hotlist);
      await this.store.setLastCollect();
    }

    const latestStatus = await this.store.getStatus();
    const digestInterval = budgetDigestInterval(config, latestStatus);
    if (input.forceDigest || shouldRun(latestStatus.lastDigestAt, digestInterval)) {
      performed = true;
      const inserted = await this.generateDigestTopics(cookie);
      changed = changed || inserted;
      await this.store.setLastDigest();
    }

    if (!performed) {
      return {
        ran: true,
        changed,
        reason: "no-op"
      };
    }

    return {
      ran: true,
      changed,
      reason: changed ? "added" : "no-op"
    };
  }

  private async generateDigestTopics(cookie: string): Promise<boolean> {
    const profileRefresh = await this.refreshInterestsIfNeeded();
    if (profileRefresh.tokenUsed > 0) {
      await this.store.addTokenUsed(profileRefresh.tokenUsed);
    }

    const profile = profileRefresh.profile;
    const [feed, hotlist] = await Promise.all([this.store.loadFeed(), this.store.loadHotlist()]);
    const watched = await this.store.loadWatched();

    const matched = this.matcher.match({
      feedItems: feed.items,
      hotItems: hotlist.items,
      interests: profile,
      eventFreshWindowMs: this.getConfig().browse.eventFreshWindowMs
    });

    const unseen = matched.filter((candidate) => !watched.has(candidate.item.bvid)).slice(0, 5);
    if (unseen.length === 0) {
      return false;
    }

    const enriched = await this.enrichCandidates(cookie, unseen);
    const materials = this.digestGenerator.build({
      candidates: enriched,
      maxItems: 5
    });
    if (materials.length === 0) {
      return false;
    }

    let changed = false;

    for (const entry of materials) {
      const inserted = await this.memory.addTopic({
        text: entry.previewText,
        source: entry.source,
        expiresAt: entry.expiresAt,
        material: entry.material
      });
      changed = changed || inserted;
      if (inserted) {
        watched.add(entry.bvid);
      }
    }

    if (changed) {
      await this.store.saveWatched(watched);
    }
    return changed;
  }

  private async enrichCandidates(cookie: string, candidates: MatchedCandidate[]): Promise<DigestInputCandidate[]> {
    const enriched: DigestInputCandidate[] = [];

    for (const candidate of candidates) {
      const next: DigestInputCandidate = {
        ...candidate
      };

      try {
        next.detail = await this.collector.fetchVideoDetail(cookie, candidate.item.bvid);
      } catch {
        // ignore per-item detail failure
      }

      const aid = candidate.item.aid;
      if (typeof aid === "number" && aid > 0) {
        try {
          next.topComments = await this.collector.fetchTopComments(cookie, aid, 5);
        } catch {
          // ignore per-item comment failure
        }
      }

      enriched.push(next);
    }

    return enriched;
  }

  private async refreshInterestsIfNeeded(): Promise<{
    profile: InterestProfile;
    tokenUsed: number;
  }> {
    const current = await this.memory.getInterestProfile();
    const history = await this.memory.listHistory({
      resourceId: PRIMARY_RESOURCE_ID,
      threadId: PRIMARY_THREAD_ID,
      limit: 120,
      offset: 0
    });

    const userMessages = history.filter((message) => message.role === "user");
    if (userMessages.length === 0) {
      return {
        profile: current,
        tokenUsed: 0
      };
    }

    const latestUserTimestamp = userMessages.reduce((latest, message) => {
      const ts = new Date(message.timestamp).getTime();
      return Number.isFinite(ts) && ts > latest ? ts : latest;
    }, 0);

    const currentUpdatedAt = new Date(current.updatedAt).getTime();
    if (Number.isFinite(currentUpdatedAt) && latestUserTimestamp <= currentUpdatedAt) {
      return {
        profile: current,
        tokenUsed: 0
      };
    }

    const transcript = userMessages
      .slice(0, 80)
      .reverse()
      .map((message) => `${message.timestamp} 用户: ${message.text}`)
      .join("\n");

    const config = this.getConfig();
    const model = this.modelFactory.getChatModel();

    const result = await generateObject({
      model,
      providerOptions: resolveOpenAIStoreOption(config),
      schema: interestSchema,
      system: [
        "你负责从用户聊天里提取兴趣画像标签。",
        "输出 games/creators/domains/dislikes/keywords。",
        "只保留稳定兴趣，不要把一次性的短句当兴趣。",
        "每个数组去重、短词优先。"
      ].join("\n"),
      prompt: [
        `当前兴趣画像:\n${JSON.stringify(current, null, 2)}`,
        `最近用户消息:\n${transcript}`,
        "请给出更新后的标签数组。"
      ].join("\n\n"),
      maxOutputTokens: 500
    });

    const parsed = interestSchema.parse(result.object ?? {
      games: [],
      creators: [],
      domains: [],
      dislikes: [],
      keywords: []
    });

    const merged: InterestProfile = normalizeInterestProfile({
      games: uniq([...current.games, ...parsed.games]),
      creators: uniq([...current.creators, ...parsed.creators]),
      domains: uniq([...current.domains, ...parsed.domains]),
      dislikes: uniq([...current.dislikes, ...parsed.dislikes]),
      keywords: uniq([...current.keywords, ...parsed.keywords]),
      updatedAt: new Date().toISOString()
    });

    const usage = parseUsageTokens((result as { usage?: unknown }).usage ?? result.usage);
    const tokenUsed =
      usage.tokens > 0 ? usage.tokens : estimateTokensFromText(transcript, JSON.stringify(parsed));

    reportTokenUsage({
      source: "browse:bilibili-interest",
      usage: result.usage,
      inputText: transcript,
      outputText: JSON.stringify(parsed)
    });

    const persisted = await this.memory.saveInterestProfile(merged);
    return {
      profile: persisted,
      tokenUsed
    };
  }
}
