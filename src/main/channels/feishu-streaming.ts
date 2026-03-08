import type { Client } from "@larksuiteoapi/node-sdk";

interface FeishuStreamingCredentials {
  appId: string;
  appSecret: string;
}

interface FeishuCardState {
  cardId: string;
  messageId: string;
  sequence: number;
  currentText: string;
}

interface TokenCacheItem {
  token: string;
  expiresAt: number;
}

const API_BASE = "https://open.feishu.cn/open-apis";
const TOKEN_ENDPOINT = `${API_BASE}/auth/v3/tenant_access_token/internal`;
const CREATE_CARD_ENDPOINT = `${API_BASE}/cardkit/v1/cards`;
const TOKEN_EXPIRE_GUARD_MS = 60_000;

const tokenCache = new Map<string, TokenCacheItem>();

function buildSummary(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "回复完成";
  }
  if (normalized.length <= 50) {
    return normalized;
  }
  return `${normalized.slice(0, 47)}...`;
}

async function fetchJson(
  input: string,
  init?: RequestInit
): Promise<Record<string, unknown>> {
  const response = await fetch(input, init);
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const detail = typeof payload.msg === "string" ? payload.msg : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return payload;
}

async function getTenantToken(creds: FeishuStreamingCredentials): Promise<string> {
  const cacheKey = creds.appId;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + TOKEN_EXPIRE_GUARD_MS) {
    return cached.token;
  }

  const payload = await fetchJson(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      app_id: creds.appId,
      app_secret: creds.appSecret
    })
  });

  const code = typeof payload.code === "number" ? payload.code : -1;
  const token = typeof payload.tenant_access_token === "string" ? payload.tenant_access_token : "";
  const expireSeconds = typeof payload.expire === "number" ? payload.expire : 7200;
  if (code !== 0 || !token) {
    const message = typeof payload.msg === "string" ? payload.msg : "tenant token fetch failed";
    throw new Error(message);
  }

  tokenCache.set(cacheKey, {
    token,
    expiresAt: Date.now() + expireSeconds * 1000
  });

  return token;
}

export class FeishuStreamingSession {
  private state: FeishuCardState | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private pendingText: string | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushAt = 0;
  private readonly throttleMs: number;

  constructor(
    private readonly client: Client,
    private readonly creds: FeishuStreamingCredentials,
    options?: {
      throttleMs?: number;
    }
  ) {
    this.throttleMs = Math.max(50, options?.throttleMs ?? 100);
  }

  async start(chatId: string): Promise<void> {
    if (this.state || this.closed) {
      return;
    }

    const token = await getTenantToken(this.creds);
    const cardPayload = {
      schema: "2.0",
      config: {
        streaming_mode: true,
        summary: {
          content: "[Generating...]"
        },
        streaming_config: {
          print_frequency_ms: {
            default: 50
          },
          print_step: {
            default: 1
          }
        }
      },
      body: {
        elements: [
          {
            tag: "markdown",
            content: "⏳ 思考中...",
            element_id: "content"
          }
        ]
      }
    };

    const createPayload = await fetchJson(CREATE_CARD_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        type: "card_json",
        data: JSON.stringify(cardPayload)
      })
    });
    const createCode = typeof createPayload.code === "number" ? createPayload.code : -1;
    const createMsg = typeof createPayload.msg === "string" ? createPayload.msg : "create card failed";
    const createData =
      createPayload.data && typeof createPayload.data === "object"
        ? (createPayload.data as Record<string, unknown>)
        : null;
    const cardId = typeof createData?.card_id === "string" ? createData.card_id : "";
    if (createCode !== 0 || !cardId) {
      throw new Error(createMsg);
    }

    const sendResult = (await this.client.im.message.create({
      params: {
        receive_id_type: "chat_id"
      },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify({
          type: "card",
          data: {
            card_id: cardId
          }
        })
      }
    })) as Record<string, unknown>;
    const sendCode = typeof sendResult.code === "number" ? sendResult.code : 0;
    const sendMsg = typeof sendResult.msg === "string" ? sendResult.msg : "send card failed";
    const sendData =
      sendResult.data && typeof sendResult.data === "object"
        ? (sendResult.data as Record<string, unknown>)
        : null;
    const messageId = typeof sendData?.message_id === "string" ? sendData.message_id : "";
    if (sendCode !== 0 || !messageId) {
      throw new Error(sendMsg);
    }

    this.state = {
      cardId,
      messageId,
      sequence: 1,
      currentText: ""
    };
  }

  async update(fullText: string): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }

    if (fullText === this.state.currentText && this.pendingText === null) {
      return;
    }

    this.pendingText = fullText;
    this.requestFlush();
  }

  async close(finalText?: string): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }

    this.closed = true;
    this.clearFlushTimer();
    if (typeof finalText === "string") {
      this.pendingText = finalText;
    }

    await this.flushPending();
    await this.queue.catch(() => undefined);

    if (!this.state) {
      return;
    }

    const text = this.state.currentText;
    this.state.sequence += 1;
    const sequence = this.state.sequence;
    const cardId = this.state.cardId;
    const summary = buildSummary(text);

    const token = await getTenantToken(this.creds);
    await fetchJson(`${API_BASE}/cardkit/v1/cards/${cardId}/settings`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        settings: JSON.stringify({
          config: {
            streaming_mode: false,
            summary: {
              content: summary
            }
          }
        }),
        sequence,
        uuid: `close_${cardId}_${sequence}`
      })
    }).catch(() => undefined);

    this.state = null;
  }

  isActive(): boolean {
    return this.state !== null && !this.closed;
  }

  private requestFlush(): void {
    if (this.flushTimer || !this.state || this.closed) {
      return;
    }

    const wait = Math.max(0, this.throttleMs - (Date.now() - this.lastFlushAt));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushPending();
    }, wait);
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) {
      return;
    }
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private async flushPending(): Promise<void> {
    if (!this.state) {
      return;
    }
    const next = this.pendingText;
    this.pendingText = null;

    if (next === null || next === this.state.currentText) {
      if (this.pendingText !== null) {
        this.requestFlush();
      }
      return;
    }

    const cardId = this.state.cardId;
    this.state.sequence += 1;
    const sequence = this.state.sequence;
    this.state.currentText = next;
    this.lastFlushAt = Date.now();

    this.queue = this.queue
      .then(async () => {
        const token = await getTenantToken(this.creds);
        await fetchJson(`${API_BASE}/cardkit/v1/cards/${cardId}/elements/content/content`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            content: next,
            sequence,
            uuid: `stream_${cardId}_${sequence}`
          })
        });
      })
      .catch(() => undefined);

    await this.queue;
    if (this.pendingText !== null && !this.closed) {
      this.requestFlush();
    }
  }
}
