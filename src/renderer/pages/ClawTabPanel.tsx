import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClawConnectionState, ClawEvent, ClawHistoryItem } from "@shared/types";
import { Loader2, Plug2, PlugZap, Send, Square } from "lucide-react";
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

type ClawItemKind = "assistant" | "tool" | "system" | "error" | "user";

interface ClawRenderableItem {
  id: string;
  kind: ClawItemKind;
  title: string;
  detail: string;
  timestamp: string;
  streaming?: boolean;
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

function historyItemToRenderable(item: ClawHistoryItem): ClawRenderableItem {
  if (item.role === "assistant") {
    return {
      id: item.id,
      kind: "assistant",
      title: "Claw",
      detail: item.text,
      timestamp: item.timestamp ?? new Date().toISOString(),
      streaming: false
    };
  }

  if (item.role === "user") {
    return {
      id: item.id,
      kind: "user",
      title: "你",
      detail: item.text,
      timestamp: item.timestamp ?? new Date().toISOString(),
      streaming: false
    };
  }

  if (item.role === "tool") {
    return {
      id: item.id,
      kind: "tool",
      title: "工具记录",
      detail: item.text,
      timestamp: item.timestamp ?? new Date().toISOString(),
      streaming: false
    };
  }

  return {
    id: item.id,
    kind: "system",
    title: "系统",
    detail: item.text,
    timestamp: item.timestamp ?? new Date().toISOString(),
    streaming: false
  };
}

function itemClassName(item: ClawRenderableItem): string {
  if (item.kind === "assistant") {
    return "mr-auto w-fit max-w-[88%] rounded-2xl border border-border/80 bg-white/88 px-4 py-3 text-sm text-foreground";
  }

  if (item.kind === "user") {
    return "ml-auto w-fit max-w-[80%] rounded-2xl bg-primary px-4 py-3 text-sm text-primary-foreground";
  }

  if (item.kind === "tool") {
    return "mr-auto w-full rounded-xl border border-amber-200 bg-amber-50/90 px-4 py-3 text-sm text-amber-950";
  }

  if (item.kind === "error") {
    return "mr-auto w-full rounded-xl border border-rose-200 bg-rose-50/90 px-4 py-3 text-sm text-rose-900";
  }

  return "mr-auto w-full rounded-xl border border-border/70 bg-white/70 px-4 py-3 text-sm text-foreground";
}

export function ClawTabPanel({ active }: ClawTabPanelProps) {
  const [items, setItems] = useState<ClawRenderableItem[]>([]);
  const [draft, setDraft] = useState("");
  const [connectionState, setConnectionState] = useState<ClawConnectionState>("idle");
  const [connectionMessage, setConnectionMessage] = useState("等待连接");
  const [sending, setSending] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState("");

  const chatBottomRef = useRef<HTMLDivElement | null>(null);
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

  const appendItem = useCallback((item: Omit<ClawRenderableItem, "id"> & { id?: string }) => {
    setItems((prev) => [
      ...prev,
      {
        id: item.id ?? makeId("claw-item"),
        ...item
      }
    ].slice(-240));
  }, []);

  const applyHistory = useCallback((historyItems: ClawHistoryItem[]) => {
    setItems((prev) => {
      const mapped = historyItems.map((item) => historyItemToRenderable(item));
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

      if (event.state === "connected") {
        streamMessageIdRef.current = null;
      } else {
        loadedHistoryAfterConnectRef.current = false;
      }
      return;
    }

    if (event.type === "history") {
      applyHistory(event.items);
      return;
    }

    if (event.type === "assistant-delta") {
      setItems((prev) => {
        const streamingId = streamMessageIdRef.current;
        if (!streamingId) {
          const id = makeId("claw-assistant");
          streamMessageIdRef.current = id;
          return [
            ...prev,
            {
              id,
              kind: "assistant" as const,
              title: "Claw",
              detail: event.delta,
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
              kind: "assistant" as const,
              title: "Claw",
              detail: event.delta,
              timestamp: event.timestamp,
              streaming: true
            }
          ].slice(-240);
        }

        const next = [...prev];
        next[index] = {
          ...next[index],
          detail: `${next[index].detail}${event.delta}`,
          timestamp: event.timestamp,
          streaming: true
        };
        return next;
      });
      return;
    }

    if (event.type === "assistant-final") {
      setItems((prev) => {
        const streamingId = streamMessageIdRef.current;
        if (!streamingId) {
          return [
            ...prev,
            {
              id: makeId("claw-final"),
              kind: "assistant" as const,
              title: "Claw",
              detail: event.text,
              timestamp: event.timestamp,
              streaming: false
            }
          ].slice(-240);
        }

        const index = prev.findIndex((item) => item.id === streamingId);
        if (index < 0) {
          return [
            ...prev,
            {
              id: makeId("claw-final"),
              kind: "assistant" as const,
              title: "Claw",
              detail: event.text,
              timestamp: event.timestamp,
              streaming: false
            }
          ].slice(-240);
        }

        const next = [...prev];
        next[index] = {
          ...next[index],
          detail: event.text,
          timestamp: event.timestamp,
          streaming: false
        };
        return next;
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

      appendItem({
        kind: event.phase === "error" ? "error" : "tool",
        title:
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

      appendItem({
        kind: "system",
        title: `任务状态 · ${normalizedStatus}`,
        detail: detail || "状态更新",
        timestamp: event.timestamp
      });
      return;
    }

    if (event.type === "status") {
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

    appendItem({
      kind: "error",
      title: "错误",
      detail: event.message,
      timestamp: event.timestamp
    });
  }, [appendItem, applyHistory]);

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
  }, [items]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setHistoryError("");
    try {
      const result = await window.companion.clawConnect();
      if (!result.connected) {
        setHistoryError(result.message);
        return;
      }
    } finally {
      setConnecting(false);
    }
  }, []);

  const handleDisconnect = useCallback(async () => {
    await window.companion.clawDisconnect();
  }, []);

  const handleAbort = useCallback(async () => {
    const result = await window.companion.clawAbort();
    if (!result.accepted) {
      appendItem({
        kind: "error",
        title: "中止失败",
        detail: result.message,
        timestamp: new Date().toISOString()
      });
    }
  }, [appendItem]);

  const handleSubmit = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) {
      return;
    }

    setDraft("");
    appendItem({
      kind: "user",
      title: "你",
      detail: text,
      timestamp: new Date().toISOString()
    });

    setSending(true);
    try {
      const result = await window.companion.clawSend(text);
      if (!result.accepted) {
        appendItem({
          kind: "error",
          title: "发送失败",
          detail: result.message,
          timestamp: new Date().toISOString()
        });
      }
    } finally {
      setSending(false);
    }
  }, [appendItem, draft, sending]);

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
              <CardDescription>直接与 OpenClaw 对话，查看完整执行过程。</CardDescription>
            </div>
            <Badge className={connectionBadge.className}>{connectionBadge.label}</Badge>
          </div>

          <p className="text-xs text-muted-foreground">{connectionMessage}</p>
        </CardHeader>

        <CardContent className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-2">
            {items.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border/70 bg-white/55 px-3 py-4 text-sm text-muted-foreground">
                暂无 Claw 消息。你可以直接在下方发送指令，或点击连接后查看历史。
              </p>
            ) : (
              items.map((item) => (
                <div key={item.id} className={itemClassName(item)}>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-xs font-medium opacity-80">{item.title}</span>
                    <span className="text-[11px] opacity-70">
                      {new Date(item.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap leading-relaxed">{item.detail}</p>
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
          <CardTitle>连接控制</CardTitle>
          <CardDescription>手动连接、断开、刷新历史或中止当前任务。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            type="button"
            onClick={() => void handleConnect()}
            disabled={connecting}
            className="w-full"
          >
            {connecting ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                连接中...
              </>
            ) : (
              <>
                <PlugZap className="mr-1.5 h-4 w-4" />
                连接 Claw
              </>
            )}
          </Button>

          <Button type="button" variant="outline" onClick={() => void handleDisconnect()} className="w-full">
            <Plug2 className="mr-1.5 h-4 w-4" />
            断开连接
          </Button>

          <Button type="button" variant="outline" onClick={() => void loadHistory()} disabled={loadingHistory} className="w-full">
            {loadingHistory ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                拉取历史中...
              </>
            ) : (
              "刷新最近 50 条历史"
            )}
          </Button>

          <Button type="button" variant="outline" onClick={() => void handleAbort()} className="w-full border-rose-200 text-rose-700 hover:bg-rose-50">
            <Square className="mr-1.5 h-4 w-4" />
            中止当前任务
          </Button>

          {historyError ? (
            <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {historyError}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
