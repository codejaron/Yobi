import type { QQAccessTokenResponse } from "./qq-types";

const TOKEN_ENDPOINT = "https://bots.qq.com/app/getAppAccessToken";
const REFRESH_BUFFER_MS = 120_000;

export class QQAuthManager {
  private accessToken = "";
  private expiresAt = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly appId: string,
    private readonly appSecret: string
  ) {}

  async getToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - REFRESH_BUFFER_MS) {
      return this.accessToken;
    }

    return this.refresh();
  }

  async authHeader(): Promise<string> {
    const token = await this.getToken();
    return `QQBot ${token}`;
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async refresh(): Promise<string> {
    if (this.refreshing) {
      return this.refreshing;
    }

    const task = this.refreshOnce();
    this.refreshing = task;
    try {
      return await task;
    } finally {
      if (this.refreshing === task) {
        this.refreshing = null;
      }
    }
  }

  private async refreshOnce(): Promise<string> {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        appId: this.appId,
        clientSecret: this.appSecret
      })
    });

    if (!response.ok) {
      throw new Error(`QQ token refresh failed: ${response.status}`);
    }

    const payload = (await response.json()) as QQAccessTokenResponse;
    const expiresInSeconds = Math.max(1, Number(payload.expires_in) || 0);
    this.accessToken = payload.access_token;
    this.expiresAt = Date.now() + expiresInSeconds * 1000;
    this.scheduleRefresh(expiresInSeconds);

    return this.accessToken;
  }

  private scheduleRefresh(expiresInSeconds: number): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    const delayMs = Math.max((expiresInSeconds - 120) * 1000, 60_000);
    this.refreshTimer = setTimeout(() => {
      void this.refresh().catch((error) => {
        console.warn("[qq-auth] token auto refresh failed:", error);
      });
    }, delayMs);
    this.refreshTimer.unref?.();
  }
}
