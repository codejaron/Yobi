import { randomUUID } from "node:crypto";
import type { ClawHistoryItem } from "@shared/types";
import { isRecord, summarizeUnknown } from "@main/utils/guards";
import type { ClawListSessionsParams } from "./claw-client";

export type AgentStream = "tool" | "assistant" | "lifecycle" | "unknown";

export type SessionTerminalState = "idle" | "error";

export interface SessionMonitorState {
  sessionKey: string;
  displayName: string;
  updatedAtMs: number;
  activeRunIds: Set<string>;
  lastTerminal: SessionTerminalState;
  lastError?: string;
  lastTransitionAt: string;
}

export interface NormalizedAgentPayload {
  source: Record<string, unknown> | null;
  body: unknown;
  stream: AgentStream;
  runId: string;
  sessionKey: string;
}

export const TASK_MONITOR_SESSION_PREFIX = "agent:main:";
export const TASK_MONITOR_REFRESH_MS = 30_000;
export const TASK_MONITOR_MAX_ITEMS = 20;
export const TASK_MONITOR_SESSION_LIMIT = 40;
export const TASK_MONITOR_RECENT_DAYS = 3;
export const TASK_MONITOR_ACTIVE_MINUTES = TASK_MONITOR_RECENT_DAYS * 24 * 60;
export const TASK_MONITOR_MAX_AGE_MS = TASK_MONITOR_ACTIVE_MINUTES * 60 * 1000;

export const DEFAULT_LIST_SESSION_PARAMS: ClawListSessionsParams = {
  agentId: "main",
  includeGlobal: false,
  includeUnknown: false,
  activeMinutes: TASK_MONITOR_ACTIVE_MINUTES,
  limit: TASK_MONITOR_SESSION_LIMIT
};

export function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function maybeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}


export function trimOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  return null;
}

export function toEpochMs(value: unknown): number {
  const numeric = readNumber(value);
  if (numeric !== null && numeric > 0) {
    return Math.floor(numeric);
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return Date.now();
}

export function toIsoTimestamp(input: number): string {
  if (!Number.isFinite(input) || input <= 0) {
    return new Date().toISOString();
  }

  try {
    return new Date(input).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

export function defaultMonitorDisplayName(sessionKey: string): string {
  if (!sessionKey) {
    return "main";
  }

  if (sessionKey.startsWith(TASK_MONITOR_SESSION_PREFIX)) {
    return sessionKey.slice(TASK_MONITOR_SESSION_PREFIX.length) || "main";
  }

  return sessionKey;
}

export function normalizeMonitorSessionKey(sessionKey: string, defaultSessionKey: string): string {
  const normalized = sessionKey.trim();
  if (!normalized) {
    return `${TASK_MONITOR_SESSION_PREFIX}${defaultSessionKey}`;
  }

  if (normalized === "main" || normalized === defaultSessionKey) {
    return `${TASK_MONITOR_SESSION_PREFIX}${defaultSessionKey}`;
  }

  return normalized;
}

export function isMonitoredSessionKey(sessionKey: string): boolean {
  return sessionKey.startsWith(TASK_MONITOR_SESSION_PREFIX);
}

export interface SessionListSnapshotEntry {
  sessionKey: string;
  displayName: string;
  updatedAtMs: number;
}

export function normalizeAgentPayload(payload: unknown, defaultSessionKey: string): NormalizedAgentPayload {
  const source = isRecord(payload) ? payload : null;
  const bodyCandidate = source && isRecord(source.data) ? source.data : payload;
  const streamFromSource = extractAgentStream(source ?? payload);
  const stream = streamFromSource !== "unknown" ? streamFromSource : extractAgentStream(bodyCandidate);

  const sourceSession = extractSessionKey(source ?? payload, defaultSessionKey);
  const sessionKey = extractSessionKey(bodyCandidate, sourceSession);
  const runId = extractRunId(source ?? payload) || extractRunId(bodyCandidate);

  return {
    source,
    body: bodyCandidate,
    stream,
    runId,
    sessionKey
  };
}

export function extractSessionListEntries(raw: unknown, defaultSessionKey: string): SessionListSnapshotEntry[] {
  if (!isRecord(raw) || !Array.isArray(raw.sessions)) {
    return [];
  }

  const entries: SessionListSnapshotEntry[] = [];
  for (const item of raw.sessions) {
    if (!isRecord(item)) {
      continue;
    }

    const key = maybeString(item.key)?.trim();
    if (!key) {
      continue;
    }

    const monitorKey = normalizeMonitorSessionKey(key, defaultSessionKey);
    if (!isMonitoredSessionKey(monitorKey)) {
      continue;
    }

    const displayName =
      maybeString(item.displayName)?.trim() ??
      maybeString(item.derivedTitle)?.trim() ??
      maybeString(item.label)?.trim() ??
      defaultMonitorDisplayName(monitorKey);

    entries.push({
      sessionKey: monitorKey,
      displayName,
      updatedAtMs: toEpochMs(item.updatedAt)
    });
  }

  return entries;
}

export function compactSummary(value: unknown, maxLength = 400): string {
  const summary = summarizeUnknown(value).trim();
  if (!summary) {
    return "";
  }

  if (summary.length <= maxLength) {
    return summary;
  }

  return `${summary.slice(0, maxLength)}...`;
}

export function extractContentText(content: unknown): string {
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

export function extractTextFromValue(value: unknown, depth = 0): string {
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

export function extractSessionKey(payload: unknown, fallback = "main"): string {
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

export function extractText(payload: unknown): string {
  return extractTextFromValue(payload);
}

export function extractChatErrorMessage(payload: unknown): string {
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

export function extractRunId(value: unknown, depth = 0): string {
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

export function extractAgentStream(payload: unknown): AgentStream {
  if (!isRecord(payload)) {
    return "unknown";
  }

  const stream = readString(payload.stream).trim().toLowerCase();
  if (stream === "tool" || stream === "assistant" || stream === "lifecycle") {
    return stream;
  }

  return "unknown";
}

export function extractToolName(payload: unknown): string {
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

export function extractToolInput(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return undefined;
  }

  return payload.input ?? payload.args ?? payload.parameters;
}

export function extractToolOutput(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return undefined;
  }

  return payload.output ?? payload.result ?? payload.data;
}

export function extractLifecycleStatus(payload: unknown): {
  status: string;
  detail?: string;
} {
  if (!isRecord(payload)) {
    return {
      status: "update"
    };
  }

  const status =
    maybeString(payload.phase)?.trim() ||
    maybeString(payload.state)?.trim() ||
    maybeString(payload.status)?.trim() ||
    "update";
  const detail =
    maybeString(payload.detail) ?? maybeString(payload.error) ?? maybeString(payload.message);

  return {
    status,
    detail
  };
}

export function extractChatState(payload: unknown): string {
  if (!isRecord(payload)) {
    return "";
  }

  return readString(payload.state).trim().toLowerCase();
}

export function extractHistoryArray(raw: unknown): unknown[] {
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

export function normalizeHistoryRole(value: unknown): ClawHistoryItem["role"] | null {
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

export function unwrapHistoryRecord(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) {
    return null;
  }

  if (isRecord(raw.message)) {
    return raw.message;
  }

  return raw;
}

export function normalizeHistoryText(text: string, maxLength = 8000): string {
  const normalized = text.trim();
  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}\n...(truncated)...`;
}

export function extractHistoryText(entry: Record<string, unknown>, role: ClawHistoryItem["role"]): string {
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

export function normalizeHistoryItem(raw: unknown): ClawHistoryItem | null {
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

