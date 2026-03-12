import { useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Square
} from "lucide-react";
import type { LiveToolTraceItem } from "@shared/tool-trace";
import { cn } from "@renderer/lib/utils";
import type { ConsoleMessage } from "./types";

interface AssistantProcessViewProps {
  message: ConsoleMessage;
}

export function AssistantProcessView({ message }: AssistantProcessViewProps) {
  const process = message.process;
  if (!process) {
    return null;
  }

  if (!process.thinkingVisible && process.tools.length === 0) {
    return null;
  }

  return (
    <div className="mb-2.5 flex max-w-full flex-col gap-1.5">
      {process.thinkingVisible ? <ThinkingIndicator /> : null}
      {process.tools.map((item) => (
        <ToolTraceCard
          key={`${message.requestId}-${item.id}`}
          item={item}
          allowExpand={!message.historyMode && item.detailsAvailable}
        />
      ))}
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="inline-flex w-fit max-w-full items-center gap-2 rounded-full border border-border/70 bg-card/75 px-3 py-1.5 text-[12px] text-muted-foreground shadow-sm backdrop-blur-[2px]">
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[hsl(var(--status-info-foreground))]" />
      <span className="truncate">正在整理思路…</span>
    </div>
  );
}

function ToolTraceCard({
  item,
  allowExpand
}: {
  item: LiveToolTraceItem;
  allowExpand: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const content = (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="shrink-0">{statusIcon(item.status)}</span>
            <span className="truncate text-[12px] font-medium">
              {buildStatusLabel(item)}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 pl-2 text-[11px] opacity-75">
          {typeof item.durationMs === "number" ? <span>{formatDuration(item.durationMs)}</span> : null}
          {allowExpand ? (
            expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />
          ) : null}
        </div>
      </div>

      {allowExpand && expanded ? (
        <div className="mt-3 grid gap-2 border-t border-current/15 pt-3 text-[11px]">
          <DetailBlock label="入参" value={item.input} emptyCopy="(空)" />
          <DetailBlock
            label={item.status === "error" ? "错误" : "结果"}
            value={item.status === "error" ? item.error : item.output}
            emptyCopy={item.status === "running" ? "等待返回..." : "(空)"}
          />
        </div>
      ) : null}
    </>
  );

  const className = cn(
    "max-w-full border text-left transition",
    "shadow-sm backdrop-blur-[2px]",
    expanded ? "w-full rounded-2xl px-3 py-2.5" : "w-fit rounded-full px-3 py-1.5",
    allowExpand ? "hover:brightness-[0.99]" : "",
    toneClass(item.status)
  );

  if (!allowExpand) {
    return <div className={className}>{content}</div>;
  }

  return (
    <button type="button" onClick={() => setExpanded((current) => !current)} className={className}>
      {content}
    </button>
  );
}

function DetailBlock({
  label,
  value,
  emptyCopy
}: {
  label: string;
  value: unknown;
  emptyCopy: string;
}) {
  const text = formatUnknownDetail(value, emptyCopy);
  return (
    <div className="rounded-xl border border-current/10 bg-black/[0.03] px-3 py-2 text-foreground dark:bg-white/[0.04]">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
        {text}
      </pre>
    </div>
  );
}

function toneClass(status: LiveToolTraceItem["status"]): string {
  if (status === "running") {
    return "border-[hsl(var(--status-info-border))] bg-[hsl(var(--status-info-bg))]/80 text-[hsl(var(--status-info-foreground))]";
  }

  if (status === "success") {
    return "border-[hsl(var(--border))] bg-card/80 text-foreground";
  }

  if (status === "error") {
    return "border-[hsl(var(--status-danger-border))] bg-[hsl(var(--status-danger-bg))]/80 text-[hsl(var(--status-danger-foreground))]";
  }

  return "border-[hsl(var(--status-warn-border))] bg-[hsl(var(--status-warn-bg))]/80 text-[hsl(var(--status-warn-foreground))]";
}

function statusIcon(status: LiveToolTraceItem["status"]) {
  if (status === "running") {
    return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  }

  if (status === "success") {
    return <Check className="h-3.5 w-3.5" />;
  }

  if (status === "error") {
    return <AlertTriangle className="h-3.5 w-3.5" />;
  }

  return <Square className="h-3.5 w-3.5" />;
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "";
  }

  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`;
}

function formatUnknownDetail(value: unknown, emptyCopy: string): string {
  if (typeof value === "undefined") {
    return emptyCopy;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || emptyCopy;
  }

  try {
    return JSON.stringify(value, null, 2) || emptyCopy;
  } catch {
    return String(value);
  }
}

function buildStatusLabel(item: LiveToolTraceItem): string {
  if (item.status === "running") {
    return `${item.toolName} · ${item.inputPreview}`;
  }

  if (item.status === "success") {
    return `${item.toolName} · ${item.inputPreview}`;
  }

  if (item.status === "error") {
    return `${item.toolName} · 失败 · ${item.inputPreview}`;
  }

  return `${item.toolName} · 已中断 · ${item.inputPreview}`;
}
