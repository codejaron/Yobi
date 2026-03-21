import { fileExists, readJsonFile, writeJsonFile } from "./fs";
import { CompanionPaths } from "./paths";

export type RuntimeInboundChannel = "console" | "telegram" | "qq" | "feishu";

export interface RuntimeContextStoreDocument {
  lastProactiveAt: string | null;
  lastUserAt: string | null;
  lastInboundChannel: RuntimeInboundChannel | null;
  lastInboundChatId: string | null;
  lastTelegramChatId: string | null;
  lastFeishuChatId: string | null;
  lastQQChatId: string | null;
}

const DEFAULT_RUNTIME_CONTEXT: RuntimeContextStoreDocument = {
  lastProactiveAt: null,
  lastUserAt: null,
  lastInboundChannel: null,
  lastInboundChatId: null,
  lastTelegramChatId: null,
  lastFeishuChatId: null,
  lastQQChatId: null
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(parsed).toISOString();
}

function normalizeChannel(value: unknown): RuntimeInboundChannel | null {
  if (value === "console" || value === "telegram" || value === "qq" || value === "feishu") {
    return value;
  }

  return null;
}

function normalizeChatId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeContext(raw: unknown): RuntimeContextStoreDocument {
  if (!isPlainRecord(raw)) {
    return {
      ...DEFAULT_RUNTIME_CONTEXT
    };
  }

  return {
    lastProactiveAt: normalizeTimestamp(raw.lastProactiveAt),
    lastUserAt: normalizeTimestamp(raw.lastUserAt),
    lastInboundChannel: normalizeChannel(raw.lastInboundChannel),
    lastInboundChatId: normalizeChatId(raw.lastInboundChatId),
    lastTelegramChatId: normalizeChatId(raw.lastTelegramChatId),
    lastFeishuChatId: normalizeChatId(raw.lastFeishuChatId),
    lastQQChatId: normalizeChatId(raw.lastQQChatId)
  };
}

export class RuntimeContextStore {
  private cached: RuntimeContextStoreDocument = {
    ...DEFAULT_RUNTIME_CONTEXT
  };

  constructor(private readonly paths: CompanionPaths) {}

  async init(): Promise<void> {
    const exists = await fileExists(this.paths.runtimeContextPath);
    if (!exists) {
      this.cached = {
        ...DEFAULT_RUNTIME_CONTEXT
      };
      await writeJsonFile(this.paths.runtimeContextPath, this.cached);
      return;
    }

    const raw = await readJsonFile<unknown>(this.paths.runtimeContextPath, null);
    this.cached = normalizeContext(raw);
    await writeJsonFile(this.paths.runtimeContextPath, this.cached);
  }

  getContext(): RuntimeContextStoreDocument {
    return {
      ...this.cached
    };
  }

  async saveContext(next: RuntimeContextStoreDocument): Promise<RuntimeContextStoreDocument> {
    this.cached = normalizeContext(next);
    await writeJsonFile(this.paths.runtimeContextPath, this.cached);
    return this.getContext();
  }
}
