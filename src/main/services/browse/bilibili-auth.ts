import type { BrowseAuthState } from "@shared/types";
import { BrowseStore } from "./browse-store";

const PASSPORT_BASE = "https://passport.bilibili.com";
const BILIBILI_ORIGIN = "https://www.bilibili.com";

const REQUIRED_COOKIE_KEYS = new Set([
  "SESSDATA",
  "bili_jct",
  "DedeUserID",
  "DedeUserID__ckMd5",
  "sid"
]);

export interface QrStartResult {
  authState: BrowseAuthState;
  qrcodeKey: string;
  scanUrl: string;
  expiresAt: string;
}

export interface QrPollResult {
  authState: BrowseAuthState;
  status: "pending" | "scanned" | "confirmed" | "expired" | "error";
  detail: string;
  cookieSaved: boolean;
  cookie?: string;
}

function nowPlusMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function splitSetCookies(rawHeader: string): string[] {
  return rawHeader
    .split(/,(?=[^;,=\s]+=[^;,]*)/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function readSetCookies(headers: Headers): string[] {
  const candidate = headers as Headers & {
    getSetCookie?: () => string[];
  };

  if (typeof candidate.getSetCookie === "function") {
    const values = candidate.getSetCookie().map((item) => item.trim()).filter(Boolean);
    if (values.length > 0) {
      return values;
    }
  }

  const joined = headers.get("set-cookie");
  if (!joined) {
    return [];
  }

  return splitSetCookies(joined);
}

function extractCookieFromSetCookie(headers: Headers): string {
  const map = new Map<string, string>();

  for (const item of readSetCookies(headers)) {
    const token = item.split(";")[0]?.trim();
    if (!token) {
      continue;
    }

    const separator = token.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = token.slice(0, separator).trim();
    const value = token.slice(separator + 1).trim();
    if (!key || !value) {
      continue;
    }

    map.set(key, value);
  }

  if (map.size === 0) {
    return "";
  }

  const ordered = [...REQUIRED_COOKIE_KEYS].filter((key) => map.has(key));
  const extra = [...map.keys()].filter((key) => !REQUIRED_COOKIE_KEYS.has(key));
  return [...ordered, ...extra].map((key) => `${key}=${map.get(key)}`).join("; ");
}

export function normalizeCookieString(raw: string): string {
  if (!raw.trim()) {
    return "";
  }

  const entries = raw
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separator = item.indexOf("=");
      if (separator <= 0) {
        return null;
      }
      const key = item.slice(0, separator).trim();
      const value = item.slice(separator + 1).trim();
      if (!key || !value) {
        return null;
      }
      return [key, value] as const;
    })
    .filter((item): item is readonly [string, string] => item !== null);

  const deduped = new Map<string, string>();
  for (const [key, value] of entries) {
    deduped.set(key, value);
  }

  const ordered = [...REQUIRED_COOKIE_KEYS].filter((key) => deduped.has(key));
  const extra = [...deduped.keys()].filter((key) => !REQUIRED_COOKIE_KEYS.has(key));
  return [...ordered, ...extra].map((key) => `${key}=${deduped.get(key)}`).join("; ");
}

export class BilibiliAuthService {
  constructor(private readonly store: BrowseStore) {}

  async startQrAuth(): Promise<QrStartResult> {
    const response = await fetch(`${PASSPORT_BASE}/x/passport-login/web/qrcode/generate`, {
      method: "GET",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        referer: `${BILIBILI_ORIGIN}/`,
        origin: BILIBILI_ORIGIN
      }
    });

    const payload = (await response.json().catch(() => null)) as {
      code?: number;
      message?: string;
      data?: {
        url?: string;
        qrcode_key?: string;
      };
    } | null;

    if (!response.ok || !payload || payload.code !== 0 || !payload.data?.qrcode_key || !payload.data.url) {
      const detail = payload?.message?.trim() || `HTTP ${response.status}`;
      await this.store.setAuthState("error", `二维码生成失败：${detail}`);
      throw new Error(`B 站扫码初始化失败：${detail}`);
    }

    const scanUrl = payload.data.url.trim();
    const qrcodeKey = payload.data.qrcode_key.trim();
    const expiresAt = nowPlusMinutes(3);

    await this.store.updateState((state) => ({
      ...state,
      authState: "pending",
      pausedReason: "等待扫码确认",
      qrSession: {
        qrcodeKey,
        scanUrl,
        expiresAt,
        startedAt: new Date().toISOString()
      }
    }));

    return {
      authState: "pending",
      qrcodeKey,
      scanUrl,
      expiresAt
    };
  }

  async pollQrAuth(qrcodeKey: string): Promise<QrPollResult> {
    const key = qrcodeKey.trim();
    if (!key) {
      return {
        authState: "error",
        status: "error",
        detail: "缺少 qrcodeKey",
        cookieSaved: false
      };
    }

    const response = await fetch(
      `${PASSPORT_BASE}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`,
      {
        method: "GET",
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          referer: `${BILIBILI_ORIGIN}/`,
          origin: BILIBILI_ORIGIN
        }
      }
    );

    const payload = (await response.json().catch(() => null)) as {
      code?: number;
      message?: string;
      data?: {
        code?: number;
        message?: string;
      };
    } | null;

    if (!response.ok || !payload || payload.code !== 0 || !payload.data) {
      const detail = payload?.message?.trim() || `HTTP ${response.status}`;
      await this.store.setAuthState("error", `扫码轮询失败：${detail}`);
      return {
        authState: "error",
        status: "error",
        detail,
        cookieSaved: false
      };
    }

    const code = payload.data.code;
    const detail = payload.data.message?.trim() || "";

    if (code === 86101) {
      await this.store.setAuthState("pending", "等待扫码");
      return {
        authState: "pending",
        status: "pending",
        detail: detail || "未扫码",
        cookieSaved: false
      };
    }

    if (code === 86090) {
      await this.store.setAuthState("pending", "已扫码，等待确认");
      return {
        authState: "pending",
        status: "scanned",
        detail: detail || "已扫码，待确认",
        cookieSaved: false
      };
    }

    if (code === 86038) {
      await this.store.updateState((state) => ({
        ...state,
        authState: "expired",
        pausedReason: "二维码已过期",
        qrSession: null
      }));
      return {
        authState: "expired",
        status: "expired",
        detail: detail || "二维码已过期",
        cookieSaved: false
      };
    }

    if (code !== 0) {
      await this.store.setAuthState("error", detail || `扫码状态异常：${code}`);
      return {
        authState: "error",
        status: "error",
        detail: detail || `扫码状态异常：${code}`,
        cookieSaved: false
      };
    }

    const cookie = normalizeCookieString(extractCookieFromSetCookie(response.headers));
    if (!cookie) {
      await this.store.setAuthState("error", "扫码成功但未拿到 Set-Cookie");
      return {
        authState: "error",
        status: "error",
        detail: "扫码成功但未拿到登录 Cookie",
        cookieSaved: false
      };
    }

    await this.store.updateState((state) => ({
      ...state,
      authState: "active",
      pausedReason: null,
      qrSession: null
    }));

    return {
      authState: "active",
      status: "confirmed",
      detail: "扫码成功",
      cookieSaved: true,
      cookie
    };
  }
}
