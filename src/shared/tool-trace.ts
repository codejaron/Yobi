import type { ConsoleRunEventV2, ToolTraceItem, ToolTraceStatus } from "./types";

export type LiveToolTraceStatus = ToolTraceStatus | "running";
export type ToolTraceFinalizeReason = "completed" | "failed" | "aborted";

export interface LiveToolTraceItem {
  id: string;
  toolCallId?: string;
  toolName: string;
  status: LiveToolTraceStatus;
  inputPreview: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  durationMs?: number;
  startedAt?: string;
  finishedAt?: string;
  detailsAvailable: boolean;
}

export interface AssistantTurnProcess {
  thinkingVisible: boolean;
  hasVisibleContent: boolean;
  tools: LiveToolTraceItem[];
}

const PREVIEW_KEY_GROUPS: Array<{ label: string; keys: string[] }> = [
  { label: "搜索", keys: ["q", "query", "search"] },
  { label: "URL", keys: ["url"] },
  { label: "路径", keys: ["path", "filePath", "targetPath"] },
  { label: "命令", keys: ["command", "cmd"] }
];

const MAX_PREVIEW_DEPTH = 3;

export function createAssistantTurnProcess(toolTrace?: ToolTraceItem[]): AssistantTurnProcess {
  const tools = createHistoryToolTraceItems(toolTrace);
  return {
    thinkingVisible: false,
    hasVisibleContent: tools.length > 0,
    tools
  };
}

export function createHistoryToolTraceItems(items?: ToolTraceItem[]): LiveToolTraceItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  return items.map((item, index) => ({
    id: `history-tool-${index}`,
    toolName: item.toolName,
    status: item.status,
    inputPreview: item.inputPreview,
    durationMs: item.durationMs,
    detailsAvailable: false
  }));
}

export function hasAssistantVisibleContent(
  text: string,
  process?: AssistantTurnProcess
): boolean {
  return text.trim().length > 0 || (process?.tools.length ?? 0) > 0;
}

export function buildToolInputPreview(input: unknown, maxLength = 96): string {
  for (const group of PREVIEW_KEY_GROUPS) {
    const found = findPreferredValue(input, group.keys);
    if (typeof found !== "undefined") {
      return truncateSingleLine(`${group.label}：${stringifyValue(found)}`, maxLength);
    }
  }

  return truncateSingleLine(stringifyValue(input), maxLength);
}

export function finalizeToolTraceItems(
  tools: LiveToolTraceItem[],
  reason: ToolTraceFinalizeReason,
  finishedAt?: string
): LiveToolTraceItem[] {
  if (tools.length === 0) {
    return [];
  }

  return tools.map((item) => {
    if (item.status !== "running") {
      return { ...item };
    }

    const normalizedStatus: ToolTraceStatus =
      reason === "completed" ? "aborted" : reason === "failed" ? "aborted" : "aborted";

    return {
      ...item,
      status: normalizedStatus,
      finishedAt: finishedAt ?? item.finishedAt,
      durationMs: computeDurationMs(item.startedAt, finishedAt)
    };
  });
}

export function toPersistedToolTraceItems(tools: LiveToolTraceItem[]): ToolTraceItem[] {
  return tools
    .filter((item): item is LiveToolTraceItem & { status: ToolTraceStatus } => item.status !== "running")
    .map((item) => {
      const persisted: ToolTraceItem = {
        toolName: item.toolName,
        status: item.status,
        inputPreview: item.inputPreview
      };

      if (typeof item.durationMs === "number") {
        persisted.durationMs = item.durationMs;
      }

      return persisted;
    });
}

export function applyConsoleEventToAssistantProcess(
  current: AssistantTurnProcess | undefined,
  event: ConsoleRunEventV2
): AssistantTurnProcess {
  const next: AssistantTurnProcess = current
    ? {
        thinkingVisible: current.thinkingVisible,
        hasVisibleContent: current.hasVisibleContent,
        tools: current.tools.map((item) => ({ ...item }))
      }
    : createAssistantTurnProcess();

  if (event.type === "thinking") {
    if (event.state === "stop") {
      next.thinkingVisible = false;
      return next;
    }

    if (!next.hasVisibleContent) {
      next.thinkingVisible = true;
    }
    return next;
  }

  if (event.type === "text-delta") {
    if (event.delta) {
      next.hasVisibleContent = true;
      next.thinkingVisible = false;
    }
    return next;
  }

  if (event.type === "tool-call") {
    next.tools = recordToolCallStarted(next.tools, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      timestamp: event.timestamp
    });
    next.hasVisibleContent = true;
    next.thinkingVisible = false;
    return next;
  }

  if (event.type === "tool-result") {
    next.tools = recordToolCallSettled(next.tools, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      output: event.output,
      error: event.error,
      success: event.success,
      timestamp: event.timestamp
    });
    return next;
  }

  if (event.type === "final") {
    next.thinkingVisible = false;
    next.tools = finalizeToolTraceItems(
      next.tools,
      event.finishReason === "aborted" ? "aborted" : "completed",
      event.timestamp
    );
    return next;
  }

  if (event.type === "error") {
    next.thinkingVisible = false;
    next.tools = finalizeToolTraceItems(next.tools, "failed", event.timestamp);
    return next;
  }

  return next;
}

interface ToolCallStartInput {
  toolCallId: string;
  toolName: string;
  input: unknown;
  timestamp: string;
}

interface ToolCallResultInput extends ToolCallStartInput {
  output?: unknown;
  error?: string;
  success: boolean;
}

export function recordToolCallStarted(
  tools: LiveToolTraceItem[],
  input: ToolCallStartInput
): LiveToolTraceItem[] {
  const next = tools.map((item) => ({ ...item }));
  const index = next.findIndex((item) => item.toolCallId === input.toolCallId);
  const item: LiveToolTraceItem = {
    id: input.toolCallId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    status: "running",
    inputPreview: buildToolInputPreview(input.input),
    input: input.input,
    startedAt: input.timestamp,
    detailsAvailable: true
  };

  if (index >= 0) {
    next[index] = {
      ...next[index],
      ...item
    };
    return next;
  }

  next.push(item);
  return next;
}

export function recordToolCallSettled(
  tools: LiveToolTraceItem[],
  input: ToolCallResultInput
): LiveToolTraceItem[] {
  const next = tools.map((item) => ({ ...item }));
  const index = next.findIndex((item) => item.toolCallId === input.toolCallId);
  const existing = index >= 0 ? next[index] : undefined;
  const startedAt = existing?.startedAt ?? input.timestamp;
  const finishedAt = input.timestamp;
  const item: LiveToolTraceItem = {
    id: input.toolCallId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    status: input.success ? "success" : "error",
    inputPreview: existing?.inputPreview ?? buildToolInputPreview(input.input),
    input: existing?.input ?? input.input,
    output: input.output,
    error: input.error,
    startedAt,
    finishedAt,
    durationMs: computeDurationMs(startedAt, finishedAt),
    detailsAvailable: true
  };

  if (index >= 0) {
    next[index] = item;
    return next;
  }

  next.push(item);
  return next;
}

function computeDurationMs(startedAt?: string, finishedAt?: string): number | undefined {
  if (!startedAt || !finishedAt) {
    return undefined;
  }

  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return undefined;
  }

  const durationMs = end - start;
  return durationMs > 0 ? durationMs : undefined;
}

function truncateSingleLine(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "(空)";
  }

  if (!Number.isFinite(maxLength) || maxLength <= 0 || compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength)}...`;
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    typeof value === "bigint"
  ) {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function findPreferredValue(value: unknown, keys: string[], depth = 0): unknown {
  if (depth > MAX_PREVIEW_DEPTH || value === null || typeof value === "undefined") {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPreferredValue(item, keys, depth + 1);
      if (typeof found !== "undefined") {
        return found;
      }
    }
    return undefined;
  }

  if (typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (key in record && typeof record[key] !== "undefined") {
      return record[key];
    }
  }

  for (const child of Object.values(record)) {
    const found = findPreferredValue(child, keys, depth + 1);
    if (typeof found !== "undefined") {
      return found;
    }
  }

  return undefined;
}
