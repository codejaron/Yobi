import type { FeedSnapshot, HotlistSnapshot, BilibiliVideoItem } from "./types";
import { selectTopComments } from "./material-utils";

const BILIBILI_BASE = "https://api.bilibili.com";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function compactStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => asString(item))
    .filter(Boolean)
    .slice(0, 12);
}

function safeUrl(bvid: string): string {
  return `https://www.bilibili.com/video/${bvid}`;
}

export class BilibiliCollector {
  private createHeaders(cookie: string): Record<string, string> {
    return {
      cookie,
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      referer: "https://www.bilibili.com/",
      origin: "https://www.bilibili.com"
    };
  }

  private async fetchJson(path: string, cookie: string): Promise<Record<string, unknown>> {
    const response = await fetch(`${BILIBILI_BASE}${path}`, {
      method: "GET",
      headers: this.createHeaders(cookie)
    });

    const payload = (await response.json().catch(() => null)) as
      | {
          code?: number;
          message?: string;
          data?: unknown;
        }
      | null;

    if (!response.ok || !payload || payload.code !== 0 || !asRecord(payload.data)) {
      const detail = payload?.message?.trim() || `HTTP ${response.status}`;
      throw new Error(`B 站接口失败 ${path}: ${detail}`);
    }

    return payload.data as Record<string, unknown>;
  }

  async checkLogin(cookie: string): Promise<{
    isLogin: boolean;
    uname: string;
    message: string;
  }> {
    const data = await this.fetchJson("/x/web-interface/nav", cookie);
    const isLogin = data.isLogin === true || data.isLogin === 1;
    const uname = asString(data.uname);
    return {
      isLogin,
      uname,
      message: isLogin ? `已登录${uname ? `(${uname})` : ""}` : "Cookie 已失效"
    };
  }

  async collect(cookie: string): Promise<{
    feed: FeedSnapshot;
    hotlist: HotlistSnapshot;
  }> {
    const [feedData, hotData] = await Promise.all([
      this.fetchJson("/x/polymer/web-dynamic/v1/feed/all", cookie),
      this.fetchJson("/x/web-interface/popular?pn=1&ps=50", cookie)
    ]);

    const fetchedAt = new Date().toISOString();
    return {
      feed: {
        fetchedAt,
        items: this.parseFeed(feedData)
      },
      hotlist: {
        fetchedAt,
        items: this.parseHotlist(hotData)
      }
    };
  }

  async fetchVideoDetail(cookie: string, bvid: string): Promise<{
    desc: string;
    tags: string[];
    cid?: number;
    durationSec?: number;
    pubTs?: number;
  }> {
    const data = await this.fetchJson(`/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, cookie);
    const owner = asRecord(data.owner);
    const ownerName = asString(owner?.name);
    const tname = asString(data.tname);
    const desc = asString(data.desc);
    const cid = asNumber(data.cid);
    const durationSec = asNumber(data.duration);
    const pubTs = asNumber(data.pubdate);

    const tags = [tname, ownerName]
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 8);

    return {
      desc,
      tags,
      cid,
      durationSec,
      pubTs
    };
  }

  async fetchTopComments(cookie: string, aid: number, limit = 5): Promise<Array<{ text: string; likes: number }>> {
    const response = await fetch(
      `${BILIBILI_BASE}/x/v2/reply/main?type=1&oid=${encodeURIComponent(String(aid))}&mode=3&ps=20`,
      {
        method: "GET",
        headers: this.createHeaders(cookie)
      }
    );

    if (!response.ok) {
      throw new Error(`拉取评论失败: HTTP ${response.status}`);
    }

    const payload = (await response.json().catch(() => null)) as
      | {
          code?: number;
          message?: string;
          data?: unknown;
        }
      | null;
    if (!payload || payload.code !== 0 || !asRecord(payload.data)) {
      const detail = payload?.message?.trim() || `HTTP ${response.status}`;
      throw new Error(`拉取评论失败: ${detail}`);
    }

    const data = payload.data as Record<string, unknown>;
    const replies = Array.isArray(data.replies) ? data.replies : [];
    const top = asRecord(data.top);
    const topReplies = Array.isArray(top?.replies) ? top?.replies : [];
    const merged = [...topReplies, ...replies];
    if (merged.length === 0) {
      return [];
    }

    const parsed: Array<{ text: string; likes: number }> = [];
    for (const item of merged) {
      const row = asRecord(item);
      if (!row) {
        continue;
      }

      const content = asRecord(row.content);
      const text = asString(content?.message);
      const likes = asNumber(row.like) ?? 0;
      if (!text) {
        continue;
      }
      parsed.push({
        text,
        likes
      });
    }

    return selectTopComments(parsed, limit);
  }

  private parseFeed(data: Record<string, unknown>): BilibiliVideoItem[] {
    const itemsRaw = Array.isArray(data.items) ? data.items : [];
    const parsed: BilibiliVideoItem[] = [];

    for (const entry of itemsRaw) {
      const item = asRecord(entry);
      if (!item) {
        continue;
      }

      const modules = asRecord(item.modules);
      const author = asRecord(modules?.module_author);
      const dynamic = asRecord(modules?.module_dynamic);
      const major = asRecord(dynamic?.major);
      const archive = asRecord(major?.archive);
      if (!archive) {
        continue;
      }

      const bvid = asString(archive.bvid) || asString(item.bvid);
      if (!bvid) {
        continue;
      }

      const stat = asRecord(archive.stat);
      const pubTs = asNumber(author?.pub_ts) ?? asNumber(archive.pubdate);
      const title = asString(archive.title);
      if (!title) {
        continue;
      }

      parsed.push({
        bvid,
        aid: asNumber(archive.aid),
        cid: asNumber(archive.cid),
        title,
        ownerName: asString(author?.name) || asString(asRecord(archive.owner)?.name) || "未知 UP",
        ownerMid: asString(author?.mid),
        cover: asString(archive.cover),
        description: asString(archive.desc),
        tags: compactStrings(archive.tname ? [archive.tname] : []),
        source: "feed",
        view: asNumber(stat?.view),
        durationSec: asNumber(archive.duration),
        like: asNumber(stat?.like),
        pubTs,
        dynamicId: asString(item.id_str),
        url: safeUrl(bvid)
      });

      if (parsed.length >= 120) {
        break;
      }
    }

    return parsed;
  }

  private parseHotlist(data: Record<string, unknown>): BilibiliVideoItem[] {
    const listRaw = Array.isArray(data.list) ? data.list : [];
    const parsed: BilibiliVideoItem[] = [];

    for (const entry of listRaw) {
      const item = asRecord(entry);
      if (!item) {
        continue;
      }

      const bvid = asString(item.bvid);
      const title = asString(item.title);
      if (!bvid || !title) {
        continue;
      }

      const owner = asRecord(item.owner);
      const stat = asRecord(item.stat);
      const tags = [
        asString(item.tname),
        ...compactStrings(item.rcmd_reason ? [asString(asRecord(item.rcmd_reason)?.content)] : [])
      ]
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 8);

      parsed.push({
        bvid,
        aid: asNumber(item.aid),
        cid: asNumber(item.cid),
        title,
        ownerName: asString(owner?.name) || "热门内容",
        ownerMid: asString(owner?.mid),
        cover: asString(item.pic),
        description: asString(item.desc),
        tags,
        source: "hot",
        view: asNumber(stat?.view),
        durationSec: asNumber(item.duration),
        like: asNumber(stat?.like),
        pubTs: asNumber(item.pubdate),
        url: safeUrl(bvid)
      });

      if (parsed.length >= 80) {
        break;
      }
    }

    return parsed;
  }
}
