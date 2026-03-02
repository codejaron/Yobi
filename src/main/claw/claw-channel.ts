import { randomUUID } from "node:crypto";
import type { ClawEvent, ClawHistoryItem, ClawOrigin } from "@shared/types";
import { isRecord, summarizeUnknown } from "@main/utils/guards";
import type { ClawClient } from "./claw-client";
import type { ClawEventFrame } from "./protocol";

interface ClawChannelInput {
  defaultSessionKey?: string;
  onYobiFinal?: (input: {
    sessionKey: string;
    text: string;
    timestamp: string;
  }) => void | Promise<void>;
}

type Listener = (event: ClawEvent) => void;

type AgentStream = "tool" | "assistant" | "lifecycle" | "unknown";

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function maybeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}


function trimOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function compactSummary(value: unknown, maxLength = 400): string {
  const summary = summarizeUnknown(value).trim();
  if (!summary) {
    return "";
  }

  if (summary.length <= maxLength) {
    return summary;
  }

  return `${summary.slice(0, maxLength)}...`;
}

function extractContentText(content: unknown): string {
  if (typeof content === "string" && content.trim()) {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const text = content
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (!isRecord(item)) {
        return "";
      }

      if (item.type === "text" && typeof item.text === "string") {
        return item.text;
      }

      if (typeof item.text === "string") {
        return item.text;
      }

      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();

  return text;
}

function extractTextFromValue(value: unknown, depth = 0): string {
  if (depth > 2) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (!isRecord(value)) {
    return "";
  }

  const directCandidates = [value.text, value.delta, value.final, value.output];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  const contentText = extractContentText(value.content);
  if (contentText) {
    return contentText;
  }

  const nestedCandidates = [value.message, value.data];
  for (const candidate of nestedCandidates) {
    const text = extractTextFromValue(candidate, depth + 1).trim();
    if (text) {
      return text;
    }
  }

  return "";
}

function extractSessionKey(payload: unknown, fallback = "main"): string {
  if (!isRecord(payload)) {
    return fallback;
  }

  const candidates = [payload.sessionKey, payload.session, payload.key];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return fallback;
}

function extractText(payload: unknown): string {
  return extractTextFromValue(payload);
}

function extractChatErrorMessage(payload: unknown): string {
  if (!isRecord(payload)) {
    return trimOrEmpty(payload);
  }

  const directCandidates = [
    payload.errorMessage,
    payload.reason,
    payload.message,
    isRecord(payload.error) ? payload.error.message : payload.error
  ];

  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  const nestedCandidates = [payload.message, payload.data];
  for (const candidate of nestedCandidates) {
    const text = extractText(candidate).trim();
    if (text) {
      return text;
    }
  }

  return compactSummary(payload);
}

function extractRunId(value: unknown, depth = 0): string {
  if (depth > 2 || !isRecord(value)) {
    return "";
  }

  const directCandidates = [value.runId, value.run_id];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  const nestedCandidates = [value.run, value.meta, value.message, value.data];
  for (const candidate of nestedCandidates) {
    const nested = extractRunId(candidate, depth + 1);
    if (nested) {
      return nested;
    }
  }

  return "";
}

function extractAgentStream(payload: unknown): AgentStream {
  if (!isRecord(payload)) {
    return "unknown";
  }

  const stream = readString(payload.stream).trim().toLowerCase();
  if (stream === "tool" || stream === "assistant" || stream === "lifecycle") {
    return stream;
  }

  return "unknown";
}

function extractToolName(payload: unknown): string {
  if (!isRecord(payload)) {
    return "tool";
  }

  const tool = payload.tool;
  if (typeof tool === "string" && tool.trim()) {
    return tool.trim();
  }

  if (isRecord(tool) && typeof tool.name === "string" && tool.name.trim()) {
    return tool.name.trim();
  }

  const name = payload.name;
  if (typeof name === "string" && name.trim()) {
    return name.trim();
  }

  return "tool";
}

function extractToolInput(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return undefined;
  }

  return payload.input ?? payload.args ?? payload.parameters;
}

function extractToolOutput(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return undefined;
  }

  return payload.output ?? payload.result ?? payload.data;
}

function extractLifecycleStatus(payload: unknown): {
  status: string;
  detail?: string;
} {
  if (!isRecord(payload)) {
    return {
      status: "update"
    };
  }

  const status =
    maybeString(payload.state)?.trim() || maybeString(payload.status)?.trim() || "update";
  const detail = maybeString(payload.detail) ?? maybeString(payload.message);

  return {
    status,
    detail
  };
}

function extractChatState(payload: unknown): string {
  if (!isRecord(payload)) {
    return "";
  }

  return readString(payload.state).trim().toLowerCase();
}

function extractHistoryArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) {
    return raw;
  }

  if (!isRecord(raw)) {
    return [];
  }

  const candidates = [raw.items, raw.messages, raw.history, raw.data];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function normalizeHistoryRole(value: unknown): ClawHistoryItem["role"] | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/[\s_-]/g, "");
  if (!normalized) {
    return null;
  }

  if (normalized === "user" || normalized === "human") {
    return "user";
  }

  if (normalized === "assistant" || normalized === "model") {
    return "assistant";
  }

  if (normalized === "system" || normalized === "developer") {
    return "system";
  }

  if (
    normalized === "tool" ||
    normalized === "toolcall" ||
    normalized === "toolresult" ||
    normalized === "function" ||
    normalized === "functioncall" ||
    normalized === "functionresult"
  ) {
    return "tool";
  }

  return null;
}

function unwrapHistoryRecord(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) {
    return null;
  }

  if (isRecord(raw.message)) {
    return raw.message;
  }

  return raw;
}

function normalizeHistoryText(text: string, maxLength = 8000): string {
  const normalized = text.trim();
  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}\n...(truncated)...`;
}

function extractHistoryText(entry: Record<string, unknown>, role: ClawHistoryItem["role"]): string {
  const contentText = extractContentText(entry.content);
  if (contentText.trim()) {
    return normalizeHistoryText(contentText);
  }

  const directCandidates = [
    entry.text,
    entry.outputText,
    entry.output_text,
    entry.errorMessage,
    entry.error,
    entry.summary,
    entry.reason
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return normalizeHistoryText(candidate);
    }
  }

  if (typeof entry.message === "string" && entry.message.trim()) {
    return normalizeHistoryText(entry.message);
  }

  if (role === "tool" || role === "system") {
    const fallback = compactSummary(
      entry.details ?? entry.output ?? entry.result ?? entry.payload ?? entry.data
    );
    if (fallback) {
      return normalizeHistoryText(fallback);
    }
  }

  return "";
}

function normalizeHistoryItem(raw: unknown): ClawHistoryItem | null {
  if (typeof raw === "string" && raw.trim()) {
    return {
      id: randomUUID(),
      role: "assistant",
      text: raw.trim()
    };
  }

  if (!isRecord(raw)) {
    return null;
  }

  const entry = unwrapHistoryRecord(raw);
  if (!entry) {
    return null;
  }

  const role = normalizeHistoryRole(entry.role ?? raw.role);
  if (!role) {
    return null;
  }

  const text = extractHistoryText(entry, role);
  if (!text) {
    return null;
  }

  const id =
    maybeString(entry.id) ??
    maybeString(raw.id) ??
    maybeString(entry.messageId) ??
    maybeString(raw.messageId) ??
    randomUUID();

  return {
    id,
    role,
    text,
    timestamp:
      maybeString(entry.timestamp) ??
      maybeString(raw.timestamp) ??
      maybeString(entry.createdAt) ??
      maybeString(raw.createdAt) ??
      maybeString(entry.created_at) ??
      maybeString(raw.created_at)
  };
}

export class ClawChannel {
  private readonly defaultSessionKey: string;
  private readonly listeners = new Set<Listener>();
  private readonly originQueue = new Map<string, ClawOrigin[]>();
  private readonly runOrigins = new Map<string, ClawOrigin>();
  private readonly sessionRunIds = new Map<string, string>();
  private readonly chatDeltaCache = new Map<string, string>();
  private readonly unsubscribeFns: Array<() => void> = [];

  constructor(
    private readonly client: ClawClient,
    private readonly input: ClawChannelInput = {}
  ) {
    this.defaultSessionKey = this.input.defaultSessionKey?.trim() || "main";

    this.unsubscribeFns.push(
      this.client.onConnection((state, message) => {
        this.emit({
          type: "connection",
          state,
          message,
          timestamp: new Date().toISOString()
        });
      })
    );

    this.unsubscribeFns.push(
      this.client.onEvent((frame) => {
        void this.handleFrame(frame);
      })
    );

    this.unsubscribeFns.push(
      this.client.onError((error) => {
        this.emit({
          type: "error",
          message: error.message || "Claw 连接异常",
          timestamp: new Date().toISOString()
        });
      })
    );
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribeFns) {
      unsubscribe();
    }
    this.unsubscribeFns.length = 0;
    this.listeners.clear();
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async connect(): Promise<void> {
    await this.client.connect({
      manual: true
    });
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect({
      manual: true
    });
  }

  async sendFromYobi(sessionKey: string, message: string): Promise<unknown> {
    const normalizedSession = this.normalizeSessionKey(sessionKey);
    const normalizedMessage = message.trim();
    if (!normalizedMessage) {
      throw new Error("消息不能为空");
    }

    this.clearChatDelta(normalizedSession);
    this.enqueueOrigin(normalizedSession, "yobi-tool");

    try {
      const response = await this.client.send(normalizedSession, normalizedMessage);
      const runId = extractRunId(response);
      if (runId) {
        this.sessionRunIds.set(this.toOriginSessionKey(normalizedSession), runId);
        this.runOrigins.set(runId, "yobi-tool");
      }

      const timestamp = new Date().toISOString();
      this.emit({
        type: "user-message",
        sessionKey: normalizedSession,
        text: normalizedMessage,
        origin: "yobi-tool",
        timestamp
      });
      this.emit({
        type: "status",
        sessionKey: normalizedSession,
        message: "已将任务交给 Claw 执行",
        timestamp
      });
      return response;
    } catch (error) {
      this.rollbackLastOrigin(normalizedSession, "yobi-tool");
      const messageText = error instanceof Error ? error.message : summarizeUnknown(error);
      this.emit({
        type: "error",
        sessionKey: normalizedSession,
        message: messageText,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  async sendFromClaw(sessionKey: string, message: string): Promise<unknown> {
    const normalizedSession = this.normalizeSessionKey(sessionKey);
    const normalizedMessage = message.trim();
    if (!normalizedMessage) {
      throw new Error("消息不能为空");
    }

    this.clearChatDelta(normalizedSession);
    this.enqueueOrigin(normalizedSession, "claw-tab");

    try {
      const response = await this.client.send(normalizedSession, normalizedMessage);
      const runId = extractRunId(response);
      if (runId) {
        this.sessionRunIds.set(this.toOriginSessionKey(normalizedSession), runId);
        this.runOrigins.set(runId, "claw-tab");
      }
      return response;
    } catch (error) {
      this.rollbackLastOrigin(normalizedSession, "claw-tab");
      const messageText = error instanceof Error ? error.message : summarizeUnknown(error);
      this.emit({
        type: "error",
        sessionKey: normalizedSession,
        message: messageText,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  async getHistory(sessionKey: string, limit = 50): Promise<ClawHistoryItem[]> {
    const normalizedSession = this.normalizeSessionKey(sessionKey);
    const raw = await this.client.getHistory(normalizedSession, limit);
    const items = extractHistoryArray(raw)
      .map((entry) => normalizeHistoryItem(entry))
      .filter((entry): entry is ClawHistoryItem => entry !== null)
      .slice(-Math.max(1, Math.min(200, limit)));

    this.emit({
      type: "history",
      sessionKey: normalizedSession,
      items,
      timestamp: new Date().toISOString()
    });

    return items;
  }

  async abort(sessionKey: string): Promise<unknown> {
    const normalizedSession = this.normalizeSessionKey(sessionKey);
    const result = await this.client.abort(normalizedSession);

    this.emit({
      type: "status",
      sessionKey: normalizedSession,
      message: "已发送中止请求",
      timestamp: new Date().toISOString()
    });

    return result;
  }

  private normalizeSessionKey(sessionKey: string): string {
    const normalized = sessionKey.trim();
    return normalized || this.defaultSessionKey;
  }

  private enqueueOrigin(sessionKey: string, origin: ClawOrigin): void {
    const originSessionKey = this.toOriginSessionKey(sessionKey);
    const queue = this.originQueue.get(originSessionKey) ?? [];
    queue.push(origin);
    this.originQueue.set(originSessionKey, queue);
  }

  private consumeOrigin(sessionKey: string, runId?: string): ClawOrigin {
    if (runId) {
      const byRunId = this.runOrigins.get(runId);
      if (byRunId) {
        this.runOrigins.delete(runId);
        return byRunId;
      }
    }

    const originSessionKey = this.toOriginSessionKey(sessionKey);
    const queue = this.originQueue.get(originSessionKey);
    if (!queue || queue.length === 0) {
      return "unknown";
    }

    const next = queue.shift() ?? "unknown";
    if (queue.length === 0) {
      this.originQueue.delete(originSessionKey);
    } else {
      this.originQueue.set(originSessionKey, queue);
    }

    return next;
  }

  private rollbackLastOrigin(sessionKey: string, origin: ClawOrigin): void {
    const originSessionKey = this.toOriginSessionKey(sessionKey);
    const queue = this.originQueue.get(originSessionKey);
    if (!queue || queue.length === 0) {
      return;
    }

    if (queue[queue.length - 1] === origin) {
      queue.pop();
    }

    if (queue.length === 0) {
      this.originQueue.delete(originSessionKey);
    } else {
      this.originQueue.set(originSessionKey, queue);
    }
  }

  private async handleFrame(frame: ClawEventFrame): Promise<void> {
    if (frame.event === "agent") {
      this.handleAgentEvent(frame.payload);
      return;
    }

    if (frame.event === "chat") {
      await this.handleChatEvent(frame.payload);
      return;
    }

    if (frame.event === "connect.challenge") {
      return;
    }

    if (frame.event === "health" || frame.event === "tick") {
      return;
    }
  }

  private handleAgentEvent(payload: unknown): void {
    const sessionKey = extractSessionKey(payload, this.defaultSessionKey);
    this.rememberRunId(sessionKey, payload);
    const stream = extractAgentStream(payload);

    if (stream === "assistant") {
      return;
    }

    if (stream === "tool") {
      const toolName = extractToolName(payload);
      const output = extractToolOutput(payload);
      const input = extractToolInput(payload);
      const rawState = isRecord(payload) ? readString(payload.state).toLowerCase() : "";
      const error = isRecord(payload)
        ? maybeString(payload.error) ?? maybeString(payload.message)
        : undefined;

      const phase: "start" | "result" | "error" =
        rawState.includes("error") || !!error
          ? "error"
          : output !== undefined || rawState.includes("done")
            ? "result"
            : "start";

      this.emit({
        type: "tool",
        sessionKey,
        phase,
        toolName,
        input,
        output,
        error,
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (stream === "lifecycle") {
      const lifecycle = extractLifecycleStatus(payload);
      if (lifecycle.status.toLowerCase() === "update" && !lifecycle.detail) {
        return;
      }
      this.emit({
        type: "lifecycle",
        sessionKey,
        status: lifecycle.status,
        detail: lifecycle.detail,
        timestamp: new Date().toISOString()
      });
    }
  }

  private async handleChatEvent(payload: unknown): Promise<void> {
    const sessionKey = extractSessionKey(payload, this.defaultSessionKey);
    this.rememberRunId(sessionKey, payload);
    const state = extractChatState(payload);

    if (state === "delta") {
      const delta = this.resolveChatDelta(sessionKey, extractText(payload));
      if (!delta) {
        return;
      }

      this.emit({
        type: "assistant-delta",
        sessionKey,
        delta,
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (state === "final") {
      const text = extractText(payload).trim();
      if (!text) {
        return;
      }

      const runId = this.resolveRunId(sessionKey, payload);
      const origin = this.consumeOrigin(sessionKey, runId);
      const timestamp = new Date().toISOString();

      this.emit({
        type: "assistant-final",
        sessionKey,
        text,
        origin,
        timestamp
      });

      if (origin === "yobi-tool" && this.input.onYobiFinal) {
        await this.input.onYobiFinal({
          sessionKey,
          text,
          timestamp
        });
      }
      this.clearChatDelta(sessionKey);
      return;
    }

    if (state === "error") {
      const runId = this.resolveRunId(sessionKey, payload);
      const origin = this.consumeOrigin(sessionKey, runId);
      const message = extractChatErrorMessage(payload) || "Claw 任务失败";
      const timestamp = new Date().toISOString();

      this.emit({
        type: "error",
        sessionKey,
        message,
        timestamp
      });

      if (origin === "yobi-tool" && this.input.onYobiFinal) {
        await this.input.onYobiFinal({
          sessionKey,
          text: `任务失败：${message}`,
          timestamp
        });
      }
      this.clearChatDelta(sessionKey);
    }
  }

  private rememberRunId(sessionKey: string, payload: unknown): void {
    const runId = extractRunId(payload);
    if (!runId) {
      return;
    }

    this.sessionRunIds.set(this.toOriginSessionKey(sessionKey), runId);
  }

  private resolveRunId(sessionKey: string, payload: unknown): string {
    const fromPayload = extractRunId(payload);
    if (fromPayload) {
      this.sessionRunIds.set(this.toOriginSessionKey(sessionKey), fromPayload);
      return fromPayload;
    }

    return this.sessionRunIds.get(this.toOriginSessionKey(sessionKey)) ?? "";
  }

  private toOriginSessionKey(sessionKey: string): string {
    const normalized = this.normalizeSessionKey(sessionKey);
    const mainAlias = `agent:main:${this.defaultSessionKey}`;
    if (normalized === mainAlias) {
      return this.defaultSessionKey;
    }

    return normalized;
  }

  private resolveChatDelta(sessionKey: string, raw: string): string {
    const incoming = raw;
    if (!incoming) {
      return "";
    }

    const key = this.toOriginSessionKey(sessionKey);
    const previous = this.chatDeltaCache.get(key) ?? "";
    if (!previous) {
      this.chatDeltaCache.set(key, incoming);
      return incoming;
    }

    if (incoming === previous) {
      return "";
    }

    if (incoming.startsWith(previous)) {
      const delta = incoming.slice(previous.length);
      this.chatDeltaCache.set(key, incoming);
      return delta;
    }

    if (previous.startsWith(incoming)) {
      return "";
    }

    let overlap = 0;
    const max = Math.min(previous.length, incoming.length);
    for (let size = max; size > 0; size -= 1) {
      if (previous.slice(-size) === incoming.slice(0, size)) {
        overlap = size;
        break;
      }
    }

    const delta = overlap > 0 ? incoming.slice(overlap) : incoming;
    this.chatDeltaCache.set(key, `${previous}${delta}`);
    return delta;
  }

  private clearChatDelta(sessionKey: string): void {
    this.chatDeltaCache.delete(this.toOriginSessionKey(sessionKey));
  }

  private emit(event: ClawEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
