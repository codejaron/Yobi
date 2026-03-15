import type { AssistantTimelineBlock, ConsoleRunEventV2, ToolTraceItem, ToolTraceStatus } from "./types";

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

export interface AssistantTextBlock {
  id: string;
  type: "text";
  text: string;
}

export interface AssistantToolBlock {
  id: string;
  type: "tool";
  toolCallId?: string;
  item: LiveToolTraceItem;
}

export type AssistantTurnBlock = AssistantTextBlock | AssistantToolBlock;

export interface AssistantTurnProcess {
  thinkingVisible: boolean;
  hasVisibleContent: boolean;
  blocks: AssistantTurnBlock[];
  tools: LiveToolTraceItem[];
}

interface AssistantTurnHistoryInput {
  timeline?: AssistantTimelineBlock[];
}

const PREVIEW_KEY_GROUPS: Array<{ label: string; keys: string[] }> = [
  { label: "搜索", keys: ["q", "query", "search"] },
  { label: "URL", keys: ["url"] },
  { label: "路径", keys: ["path", "filePath", "targetPath"] },
  { label: "命令", keys: ["command", "cmd"] }
];

const MAX_PREVIEW_DEPTH = 3;

export function createAssistantTurnProcess(
  input?: AssistantTurnHistoryInput
): AssistantTurnProcess {
  const blocks = createHistoryBlocks(input);
  return {
    thinkingVisible: false,
    hasVisibleContent: blocks.length > 0,
    blocks,
    tools: extractToolsFromBlocks(blocks)
  };
}

export function hasAssistantVisibleContent(
  text: string,
  process?: AssistantTurnProcess
): boolean {
  return text.trim().length > 0 || (process?.blocks.length ?? 0) > 0;
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

export function toPersistedAssistantTimelineBlocks(
  blocks: AssistantTurnBlock[]
): AssistantTimelineBlock[] {
  return blocks.flatMap<AssistantTimelineBlock>((block) => {
    if (block.type === "text") {
      if (!block.text.trim()) {
        return [];
      }

      return [{ type: "text", text: block.text }];
    }

    if (block.item.status === "running") {
      return [];
    }

    const tool: ToolTraceItem = {
      toolName: block.item.toolName,
      status: block.item.status,
      inputPreview: block.item.inputPreview
    };

    if (typeof block.item.durationMs === "number") {
      tool.durationMs = block.item.durationMs;
    }

    return [{ type: "tool", tool }];
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
        blocks: current.blocks.map(cloneAssistantBlock),
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
      next.blocks = appendTextBlock(next.blocks, event.delta);
      next.tools = extractToolsFromBlocks(next.blocks);
      next.hasVisibleContent = true;
      next.thinkingVisible = false;
    }
    return next;
  }

  if (event.type === "tool-call") {
    next.blocks = recordToolCallStartedInBlocks(next.blocks, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      timestamp: event.timestamp
    });
    next.tools = extractToolsFromBlocks(next.blocks);
    next.hasVisibleContent = true;
    next.thinkingVisible = false;
    return next;
  }

  if (event.type === "tool-result") {
    next.blocks = recordToolCallSettledInBlocks(next.blocks, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      output: event.output,
      error: event.error,
      success: event.success,
      timestamp: event.timestamp
    });
    next.tools = extractToolsFromBlocks(next.blocks);
    return next;
  }

  if (event.type === "final") {
    next.thinkingVisible = false;
    next.blocks = finalizeAssistantBlocks(
      next.blocks,
      event.finishReason === "aborted" ? "aborted" : "completed",
      event.timestamp
    );
    next.tools = extractToolsFromBlocks(next.blocks);
    return next;
  }

  if (event.type === "error") {
    next.thinkingVisible = false;
    next.blocks = finalizeAssistantBlocks(next.blocks, "failed", event.timestamp);
    next.tools = extractToolsFromBlocks(next.blocks);
    return next;
  }

  return next;
}

function createHistoryBlocks(input?: AssistantTurnHistoryInput): AssistantTurnBlock[] {
  if (!input?.timeline?.length) {
    return [];
  }

  return input.timeline.flatMap<AssistantTurnBlock>((block, index) => {
    if (block.type === "text") {
      if (!block.text.trim()) {
        return [];
      }

      return [
        {
          id: `history-text-${index}`,
          type: "text",
          text: block.text
        }
      ];
    }

    return [
      {
        id: `history-tool-${index}`,
        type: "tool",
        item: {
          id: `history-tool-${index}`,
          toolName: block.tool.toolName,
          status: block.tool.status,
          inputPreview: block.tool.inputPreview,
          durationMs: block.tool.durationMs,
          detailsAvailable: false
        }
      }
    ];
  });
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

function appendTextBlock(blocks: AssistantTurnBlock[], delta: string): AssistantTurnBlock[] {
  const next = blocks.map(cloneAssistantBlock);
  const last = next.at(-1);
  if (last?.type === "text") {
    last.text += delta;
    return next;
  }

  next.push({
    id: `text-${next.length}`,
    type: "text",
    text: delta
  });
  return next;
}

function recordToolCallStartedInBlocks(
  blocks: AssistantTurnBlock[],
  input: ToolCallStartInput
): AssistantTurnBlock[] {
  const next = blocks.map(cloneAssistantBlock);
  const index = next.findIndex(
    (block) => block.type === "tool" && block.toolCallId === input.toolCallId
  );
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

  const block: AssistantToolBlock = {
    id: input.toolCallId,
    type: "tool",
    toolCallId: input.toolCallId,
    item
  };

  if (index >= 0) {
    next[index] = block;
    return next;
  }

  next.push(block);
  return next;
}

function recordToolCallSettledInBlocks(
  blocks: AssistantTurnBlock[],
  input: ToolCallResultInput
): AssistantTurnBlock[] {
  const next = blocks.map(cloneAssistantBlock);
  const index = next.findIndex(
    (block) => block.type === "tool" && block.toolCallId === input.toolCallId
  );
  const existing =
    index >= 0 && next[index]?.type === "tool" ? (next[index] as AssistantToolBlock).item : undefined;
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

  const block: AssistantToolBlock = {
    id: input.toolCallId,
    type: "tool",
    toolCallId: input.toolCallId,
    item
  };

  if (index >= 0) {
    next[index] = block;
    return next;
  }

  next.push(block);
  return next;
}

function finalizeAssistantBlocks(
  blocks: AssistantTurnBlock[],
  reason: ToolTraceFinalizeReason,
  finishedAt?: string
): AssistantTurnBlock[] {
  const finalizedTools = finalizeToolTraceItems(extractToolsFromBlocks(blocks), reason, finishedAt);
  const finalizedById = new Map(
    finalizedTools.map((item) => [item.toolCallId ?? item.id, item] as const)
  );

  return blocks.map((block) => {
    if (block.type === "text") {
      return { ...block };
    }

    const key = block.toolCallId ?? block.item.toolCallId ?? block.item.id;
    const finalized = finalizedById.get(key);
    return {
      ...block,
      item: finalized ? { ...finalized } : { ...block.item }
    };
  });
}

function extractToolsFromBlocks(blocks: AssistantTurnBlock[]): LiveToolTraceItem[] {
  return blocks.flatMap((block) => (block.type === "tool" ? [{ ...block.item }] : []));
}

function cloneAssistantBlock(block: AssistantTurnBlock): AssistantTurnBlock {
  if (block.type === "text") {
    return { ...block };
  }

  return {
    ...block,
    item: { ...block.item }
  };
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
