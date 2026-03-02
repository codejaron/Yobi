import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, RefObject } from "react";
import type { ClawConnectionState, ClawEvent, ClawHistoryItem } from "@shared/types";
import { makeClientId, summarizeUnknown } from "@renderer/pages/chat-utils";
import type { ClawActionItem, ClawChatItem, ConnectionBadge } from "./types";

const CLAW_HISTORY_LIMIT = 50;
const CLAW_CHAT_LIMIT = 240;
const CLAW_ACTION_LIMIT = 320;

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

export function chatItemClassName(item: ClawChatItem): string {
  if (item.role === "assistant") {
    return "mr-auto w-fit max-w-[88%] rounded-2xl border border-border/80 bg-white/88 px-4 py-3 text-sm text-foreground";
  }

  if (item.role === "user") {
    return "ml-auto w-fit max-w-[80%] rounded-2xl bg-primary px-4 py-3 text-sm text-primary-foreground";
  }

  return "mr-auto w-fit max-w-[88%] rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900";
}

export function actionItemClassName(kind: ClawActionItem["kind"]): string {
  if (kind === "tool") {
    return "border-amber-200 bg-amber-50/90 text-amber-950";
  }

  if (kind === "error") {
    return "border-rose-200 bg-rose-50/90 text-rose-900";
  }

  return "border-border/70 bg-white/75 text-foreground";
}

export interface ClawTabController {
  chatItems: ClawChatItem[];
  actionItems: ClawActionItem[];
  expandedActions: Record<string, boolean>;
  logEnabled: boolean;
  setLogEnabled: (enabled: boolean) => void;
  draft: string;
  setDraft: (value: string) => void;
  connectionMessage: string;
  connectionBadge: ConnectionBadge;
  sending: boolean;
  loadingHistory: boolean;
  historyError: string;
  chatBottomRef: RefObject<HTMLDivElement | null>;
  actionBottomRef: RefObject<HTMLDivElement | null>;
  clearActionLogs: () => void;
  toggleActionExpanded: (id: string) => void;
  handleAbort: () => Promise<void>;
  handleSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}

export function useClawTabController(active: boolean): ClawTabController {
  const [chatItems, setChatItems] = useState<ClawChatItem[]>([]);
  const [actionItems, setActionItems] = useState<ClawActionItem[]>([]);
  const [expandedActions, setExpandedActions] = useState<Record<string, boolean>>({});
  const [logEnabled, setLogEnabled] = useState(false);
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
        id: item.id ?? makeClientId("claw-chat"),
        ...item
      }
    ].slice(-CLAW_CHAT_LIMIT));
  }, []);

  const appendActionItem = useCallback((item: Omit<ClawActionItem, "id"> & { id?: string }) => {
    if (!logEnabled) {
      return;
    }

    setActionItems((prev) => [
      ...prev,
      {
        id: item.id ?? makeClientId("claw-action"),
        ...item
      }
    ].slice(-CLAW_ACTION_LIMIT));
  }, [logEnabled]);

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

      return [...additions, ...prev].slice(-CLAW_CHAT_LIMIT);
    });

    if (!logEnabled) {
      return;
    }

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

      return [...additions, ...prev].slice(-CLAW_ACTION_LIMIT);
    });
  }, [logEnabled]);

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    setHistoryError("");

    try {
      const response = await window.companion.clawHistory(CLAW_HISTORY_LIMIT);
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

    if (event.type === "user-message") {
      appendChatItem({
        role: "user",
        title: event.origin === "yobi-tool" ? "Yobi" : "你",
        text: event.text,
        timestamp: event.timestamp
      });
      return;
    }

    if (event.type === "assistant-delta") {
      setChatItems((prev) => {
        const streamingId = streamMessageIdRef.current;
        if (streamingId) {
          const index = prev.findIndex((item) => item.id === streamingId);
          if (index >= 0) {
            const next = [...prev];
            next[index] = {
              ...next[index],
              text: `${next[index].text}${event.delta}`,
              timestamp: event.timestamp,
              streaming: true
            };
            return next;
          }
        }

        const fallbackStreamingReverseIndex = [...prev]
          .reverse()
          .findIndex((item) => item.role === "assistant" && item.streaming);
        if (fallbackStreamingReverseIndex >= 0) {
          const index = prev.length - 1 - fallbackStreamingReverseIndex;
          const id = prev[index].id;
          streamMessageIdRef.current = id;
          const next = [...prev];
          next[index] = {
            ...next[index],
            text: `${next[index].text}${event.delta}`,
            timestamp: event.timestamp,
            streaming: true
          };
          return next;
        }

        let lastAssistantIndex = -1;
        let lastUserIndex = -1;
        for (let index = prev.length - 1; index >= 0; index -= 1) {
          const item = prev[index];
          if (lastAssistantIndex < 0 && item.role === "assistant") {
            lastAssistantIndex = index;
          }
          if (lastUserIndex < 0 && item.role === "user") {
            lastUserIndex = index;
          }
          if (lastAssistantIndex >= 0 && lastUserIndex >= 0) {
            break;
          }
        }

        if (lastAssistantIndex >= 0 && !prev[lastAssistantIndex].streaming && lastAssistantIndex > lastUserIndex) {
          const id = prev[lastAssistantIndex].id;
          streamMessageIdRef.current = id;
          const next = [...prev];
          next[lastAssistantIndex] = {
            ...next[lastAssistantIndex],
            text: event.delta,
            timestamp: event.timestamp,
            streaming: true
          };
          return next;
        }

        const id = makeClientId("claw-assistant");
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
        ].slice(-CLAW_CHAT_LIMIT);
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

        let lastAssistantIndex = -1;
        let lastUserIndex = -1;
        for (let index = prev.length - 1; index >= 0; index -= 1) {
          const item = prev[index];
          if (lastAssistantIndex < 0 && item.role === "assistant") {
            lastAssistantIndex = index;
          }
          if (lastUserIndex < 0 && item.role === "user") {
            lastUserIndex = index;
          }
          if (lastAssistantIndex >= 0 && lastUserIndex >= 0) {
            break;
          }
        }

        if (lastAssistantIndex >= 0 && lastAssistantIndex > lastUserIndex) {
          return replaceAt(lastAssistantIndex);
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
            id: makeClientId("claw-final"),
            role: "assistant" as const,
            title: "Claw",
            text: event.text,
            timestamp: event.timestamp,
            streaming: false
          }
        ].slice(-CLAW_CHAT_LIMIT);
      });

      streamMessageIdRef.current = null;
      return;
    }

    if (event.type === "tool") {
      const detailParts = [];
      if (event.input !== undefined) {
        detailParts.push(`输入:\n${summarizeUnknown(event.input, 400)}`);
      }
      if (event.output !== undefined) {
        detailParts.push(`输出:\n${summarizeUnknown(event.output, 400)}`);
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

  const clearActionLogs = useCallback(() => {
    setActionItems([]);
    setExpandedActions({});
  }, []);

  const toggleActionExpanded = useCallback((id: string) => {
    setExpandedActions((prev) => ({
      ...prev,
      [id]: !prev[id]
    }));
  }, []);

  const handleSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
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

  const connectionBadge = useMemo<ConnectionBadge>(() => {
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

  return {
    chatItems,
    actionItems,
    expandedActions,
    logEnabled,
    setLogEnabled,
    draft,
    setDraft,
    connectionMessage,
    connectionBadge,
    sending,
    loadingHistory,
    historyError,
    chatBottomRef,
    actionBottomRef,
    clearActionLogs,
    toggleActionExpanded,
    handleAbort,
    handleSubmit
  };
}
