import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClawConnectionState, ClawEvent, ClawHistoryItem } from "@shared/types";
import { Loader2, Send, Square } from "lucide-react";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@renderer/components/ui/card";
import { Input } from "@renderer/components/ui/input";

interface ClawTabPanelProps {
  active: boolean;
}

type ClawChatRole = "assistant" | "user" | "error";

interface ClawChatItem {
  id: string;
  role: ClawChatRole;
  title: string;
  text: string;
  timestamp: string;
  streaming?: boolean;
}

interface ClawActionItem {
  id: string;
  kind: "tool" | "status" | "error";
  label: string;
  detail: string;
  timestamp: string;
}

function makeId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function summarize(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatConnectionLabel(state: ClawConnectionState): string {
  if (state === "connected") {
    return "已连接";
  }

  if (state === "connecting") {
    return "连接中";
  }

  if (state === "reconnecting") {
    return "重连中";
  }

  if (state === "disconnected-manual") {
    return "已手动断开";
  }

  return "未连接";
}

function historyItemToChat(item: ClawHistoryItem): ClawChatItem | null {
  if (item.role === "assistant") {
    return {
      id: item.id,
      role: "assistant",
      title: "Claw",
      text: item.text,
      timestamp: item.timestamp ?? new Date().toISOString(),
      streaming: false
    };
  }

  if (item.role === "user") {
    return {
      id: item.id,
      role: "user",
      title: "你",
      text: item.text,
      timestamp: item.timestamp ?? new Date().toISOString(),
      streaming: false
    };
  }

  return null;
}

function historyItemToAction(item: ClawHistoryItem): ClawActionItem | null {
  if (item.role === "tool") {
    return {
      id: `history-action-${item.id}`,
      kind: "tool",
      label: "历史工具记录",
      detail: item.text,
      timestamp: item.timestamp ?? new Date().toISOString()
    };
  }

  if (item.role === "system") {
    return {
      id: `history-action-${item.id}`,
      kind: "status",
      label: "历史系统记录",
      detail: item.text,
      timestamp: item.timestamp ?? new Date().toISOString()
    };
  }

  return null;
}

function chatItemClassName(item: ClawChatItem): string {
  if (item.role === "assistant") {
    return "mr-auto w-fit max-w-[88%] rounded-2xl border border-border/80 bg-white/88 px-4 py-3 text-sm text-foreground";
  }

  if (item.role === "user") {
    return "ml-auto w-fit max-w-[80%] rounded-2xl bg-primary px-4 py-3 text-sm text-primary-foreground";
  }

  return "mr-auto w-fit max-w-[88%] rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900";
}

function actionItemClassName(kind: ClawActionItem["kind"]): string {
  if (kind === "tool") {
    return "border-amber-200 bg-amber-50/90 text-amber-950";
  }

  if (kind === "error") {
    return "border-rose-200 bg-rose-50/90 text-rose-900";
  }

  return "border-border/70 bg-white/75 text-foreground";
}

export function ClawTabPanel({ active }: ClawTabPanelProps) {
  const [chatItems, setChatItems] = useState<ClawChatItem[]>([]);
  const [actionItems, setActionItems] = useState<ClawActionItem[]>([]);
  const [expandedActions, setExpandedActions] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState("");
  const [connectionState, setConnectionState] = useState<ClawConnectionState>("idle");
  const [connectionMessage, setConnectionMessage] = useState("等待连接");
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState("");

  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  const actionBottomRef = useRef<HTMLDivElement | null>(null);
  const streamMessageIdRef = useRef<string | null>(null);
  const loadedHistoryAfterConnectRef = useRef(false);
  const lastErrorRef = useRef<{
    message: string;
    timestampMs: number;
  } | null>(null);
  const lastLifecycleRef = useRef<{
    signature: string;
    timestampMs: number;
  } | null>(null);

  const appendChatItem = useCallback((item: Omit<ClawChatItem, "id"> & { id?: string }) => {
    setChatItems((prev) => [
      ...prev,
      {
        id: item.id ?? makeId("claw-chat"),
        ...item
      }
    ].slice(-240));
  }, []);

  const appendActionItem = useCallback((item: Omit<ClawActionItem, "id"> & { id?: string }) => {
    setActionItems((prev) => [
      ...prev,
      {
        id: item.id ?? makeId("claw-action"),
        ...item
      }
    ].slice(-320));
  }, []);

  const applyHistory = useCallback((historyItems: ClawHistoryItem[]) => {
    setChatItems((prev) => {
      const mapped = historyItems
        .map((item) => historyItemToChat(item))
        .filter((item): item is ClawChatItem => item !== null);

      if (prev.length === 0) {
        return mapped;
      }

      const existingIds = new Set(prev.map((item) => item.id));
      const additions = mapped.filter((item) => !existingIds.has(item.id));
      if (additions.length === 0) {
        return prev;
      }

      return [...additions, ...prev].slice(-240);
    });

    setActionItems((prev) => {
      const mapped = historyItems
        .map((item) => historyItemToAction(item))
        .filter((item): item is ClawActionItem => item !== null);

      if (prev.length === 0) {
        return mapped;
      }

      const existingIds = new Set(prev.map((item) => item.id));
      const additions = mapped.filter((item) => !existingIds.has(item.id));
      if (additions.length === 0) {
        return prev;
      }

      return [...additions, ...prev].slice(-320);
    });
  }, []);

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    setHistoryError("");

    try {
      const response = await window.companion.clawHistory(50);
      applyHistory(response.items);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "加载历史失败");
    } finally {
      setLoadingHistory(false);
    }
  }, [applyHistory]);

  const handleEvent = useCallback((event: ClawEvent) => {
    if (event.type === "connection") {
      setConnectionState(event.state);
      setConnectionMessage(event.message);

      if (event.state !== "connected") {
        streamMessageIdRef.current = null;
        loadedHistoryAfterConnectRef.current = false;
      }
      return;
    }

    if (event.type === "history") {
      applyHistory(event.items);
      return;
    }

    if (event.type === "assistant-delta") {
      setChatItems((prev) => {
        const streamingId = streamMessageIdRef.current;
        if (!streamingId) {
          const id = makeId("claw-assistant");
          streamMessageIdRef.current = id;
          return [
            ...prev,
            {
              id,
              role: "assistant" as const,
              title: "Claw",
              text: event.delta,
              timestamp: event.timestamp,
              streaming: true
            }
          ].slice(-240);
        }

        const index = prev.findIndex((item) => item.id === streamingId);
        if (index < 0) {
          const id = makeId("claw-assistant");
          streamMessageIdRef.current = id;
          return [
            ...prev,
            {
              id,
              role: "assistant" as const,
              title: "Claw",
              text: event.delta,
              timestamp: event.timestamp,
              streaming: true
            }
          ].slice(-240);
        }

        const next = [...prev];
        next[index] = {
          ...next[index],
          text: `${next[index].text}${event.delta}`,
          timestamp: event.timestamp,
          streaming: true
        };
        return next;
      });
      return;
    }

    if (event.type === "assistant-final") {
      setChatItems((prev) => {
        const streamingId = streamMessageIdRef.current;
        const replaceAt = (index: number): ClawChatItem[] => {
          const next = [...prev];
          next[index] = {
            ...next[index],
            text: event.text,
            timestamp: event.timestamp,
            streaming: false
          };
          return next;
        };

        if (streamingId) {
          const index = prev.findIndex((item) => item.id === streamingId);
          if (index >= 0) {
            return replaceAt(index);
          }
        }

        const fallbackReverseIndex = [...prev]
          .reverse()
          .findIndex((item) => item.role === "assistant" && item.streaming);
        if (fallbackReverseIndex >= 0) {
          const index = prev.length - 1 - fallbackReverseIndex;
          return replaceAt(index);
        }

        const latestAssistant = [...prev].reverse().find((item) => item.role === "assistant");
        if (latestAssistant && !latestAssistant.streaming && latestAssistant.text === event.text) {
          const latestMs = Date.parse(latestAssistant.timestamp);
          const finalMs = Date.parse(event.timestamp);
          if (Number.isFinite(latestMs) && Number.isFinite(finalMs) && Math.abs(finalMs - latestMs) < 2_000) {
            return prev;
          }
        }

        return [
          ...prev,
          {
            id: makeId("claw-final"),
            role: "assistant" as const,
            title: "Claw",
            text: event.text,
            timestamp: event.timestamp,
            streaming: false
          }
        ].slice(-240);
      });

      streamMessageIdRef.current = null;
      return;
    }

    if (event.type === "tool") {
      const detailParts = [];
      if (event.input !== undefined) {
        detailParts.push(`输入:\n${summarize(event.input)}`);
      }
      if (event.output !== undefined) {
        detailParts.push(`输出:\n${summarize(event.output)}`);
      }
      if (event.error) {
        detailParts.push(`错误:\n${event.error}`);
      }

      appendActionItem({
        kind: event.phase === "error" ? "error" : "tool",
        label:
          event.phase === "start"
            ? `调用工具 · ${event.toolName}`
            : event.phase === "result"
              ? `工具完成 · ${event.toolName}`
              : `工具失败 · ${event.toolName}`,
        detail: detailParts.join("\n\n") || "(无详细信息)",
        timestamp: event.timestamp
      });
      return;
    }

    if (event.type === "lifecycle") {
      const status = event.status.trim();
      const detail = (event.detail ?? "").trim();
      if (!status && !detail) {
        return;
      }

      const normalizedStatus = status || "update";
      if (normalizedStatus.toLowerCase() === "update" && !detail) {
        return;
      }

      const signature = `${normalizedStatus}::${detail || "状态更新"}`;
      const nowMs = Date.now();
      const previousLifecycle = lastLifecycleRef.current;
      if (
        previousLifecycle &&
        previousLifecycle.signature === signature &&
        nowMs - previousLifecycle.timestampMs < 4_000
      ) {
        return;
      }

      lastLifecycleRef.current = {
        signature,
        timestampMs: nowMs
      };

      appendActionItem({
        kind: "status",
        label: `任务状态 · ${normalizedStatus}`,
        detail: detail || "状态更新",
        timestamp: event.timestamp
      });
      return;
    }

    if (event.type === "status") {
      appendActionItem({
        kind: "status",
        label: "状态",
        detail: event.message,
        timestamp: event.timestamp
      });
      return;
    }

    const previousError = lastErrorRef.current;
    const currentError = event.message.trim();
    const nowMs = Date.now();
    if (
      previousError &&
      previousError.message === currentError &&
      nowMs - previousError.timestampMs < 8_000
    ) {
      return;
    }

    lastErrorRef.current = {
      message: currentError,
      timestampMs: nowMs
    };

    appendActionItem({
      kind: "error",
      label: "错误",
      detail: event.message,
      timestamp: event.timestamp
    });
  }, [appendActionItem, applyHistory]);

  useEffect(() => {
    return window.companion.onClawEvent((event) => {
      handleEvent(event);
    });
  }, [handleEvent]);

  useEffect(() => {
    if (!active || connectionState !== "connected" || loadedHistoryAfterConnectRef.current) {
      return;
    }

    loadedHistoryAfterConnectRef.current = true;
    void loadHistory();
  }, [active, connectionState, loadHistory]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chatItems]);

  useEffect(() => {
    actionBottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [actionItems]);

  const handleAbort = useCallback(async () => {
    const result = await window.companion.clawAbort();
    if (!result.accepted) {
      appendActionItem({
        kind: "error",
        label: "中止失败",
        detail: result.message,
        timestamp: new Date().toISOString()
      });
      return;
    }

    appendActionItem({
      kind: "status",
      label: "状态",
      detail: result.message,
      timestamp: new Date().toISOString()
    });
  }, [appendActionItem]);

  const handleSubmit = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) {
      return;
    }

    setDraft("");
    appendChatItem({
      role: "user",
      title: "你",
      text,
      timestamp: new Date().toISOString()
    });

    setSending(true);
    try {
      const result = await window.companion.clawSend(text);
      if (!result.accepted) {
        const timestamp = new Date().toISOString();
        appendChatItem({
          role: "error",
          title: "发送失败",
          text: result.message,
          timestamp
        });
        appendActionItem({
          kind: "error",
          label: "发送失败",
          detail: result.message,
          timestamp
        });
      }
    } finally {
      setSending(false);
    }
  }, [appendActionItem, appendChatItem, draft, sending]);

  const connectionBadge = useMemo(() => {
    const label = formatConnectionLabel(connectionState);
    const className =
      connectionState === "connected"
        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
        : connectionState === "reconnecting" || connectionState === "connecting"
          ? "border-amber-200 bg-amber-50 text-amber-700"
          : "border-border/70 bg-white/75 text-muted-foreground";

    return {
      label,
      className
    };
  }, [connectionState]);

  return (
    <div className="grid h-[calc(100vh-140px)] min-h-[680px] max-h-[900px] gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="flex h-full min-h-0 flex-col overflow-hidden">
        <CardHeader className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>Claw 实时会话</CardTitle>
              <CardDescription>正文仅展示 chat 流；tool/lifecycle 在右侧日志展示。</CardDescription>
            </div>
            <Badge className={connectionBadge.className}>{connectionBadge.label}</Badge>
          </div>

          <p className="text-xs text-muted-foreground">{connectionMessage}</p>
        </CardHeader>

        <CardContent className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-2">
            {chatItems.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border/70 bg-white/55 px-3 py-4 text-sm text-muted-foreground">
                暂无 Claw 正文消息，直接在下方输入即可。
              </p>
            ) : (
              chatItems.map((item) => (
                <div key={item.id} className={chatItemClassName(item)}>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-xs font-medium opacity-80">{item.title}</span>
                    <span className="text-[11px] opacity-70">
                      {new Date(item.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap leading-relaxed">{item.text}</p>
                  {item.streaming ? (
                    <p className="mt-1 text-xs text-muted-foreground">流式输出中...</p>
                  ) : null}
                </div>
              ))
            )}
            <div ref={chatBottomRef} />
          </div>

          <form onSubmit={handleSubmit} className="flex gap-2 border-t border-border/70 pt-4">
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="直接向 Claw 发送指令"
              disabled={sending}
            />
            <Button type="submit" disabled={sending || draft.trim().length === 0}>
              {sending ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  发送中
                </>
              ) : (
                <>
                  <Send className="mr-1.5 h-4 w-4" />
                  发送
                </>
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="flex h-full min-h-0 flex-col overflow-hidden">
        <CardHeader>
          <CardTitle>执行日志</CardTitle>
          <CardDescription>过程消息默认折叠；仅保留任务中止控制。</CardDescription>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleAbort()}
            className="w-full border-rose-200 text-rose-700 hover:bg-rose-50"
          >
            <Square className="mr-1.5 h-4 w-4" />
            中止当前任务
          </Button>

          {loadingHistory ? (
            <p className="rounded-md border border-border/70 bg-white/75 px-3 py-2 text-xs text-muted-foreground">
              正在加载历史...
            </p>
          ) : null}

          {historyError ? (
            <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {historyError}
            </p>
          ) : null}

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {actionItems.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border/70 bg-white/55 px-3 py-3 text-xs text-muted-foreground">
                等待过程事件...
              </p>
            ) : (
              actionItems.map((item) => {
                const expanded = expandedActions[item.id] === true;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() =>
                      setExpandedActions((prev) => ({
                        ...prev,
                        [item.id]: !expanded
                      }))
                    }
                    className={`w-full rounded-lg border px-3 py-2 text-left text-xs transition hover:brightness-[0.99] ${actionItemClassName(item.kind)}`}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <Badge>{item.label}</Badge>
                      <span className="text-[11px] text-muted-foreground">
                        {new Date(item.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <p className={expanded ? "whitespace-pre-wrap leading-relaxed" : "truncate leading-relaxed"}>
                      {expanded ? item.detail : singleLine(item.detail)}
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">{expanded ? "点击收起" : "点击展开"}</p>
                  </button>
                );
              })
            )}
            <div ref={actionBottomRef} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
