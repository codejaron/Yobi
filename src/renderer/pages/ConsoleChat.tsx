import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppConfig, CommandApprovalDecision, ConsoleRunEventV2, HistoryMessage } from "@shared/types";
import { Loader2, Mic, Square, Trash2 } from "lucide-react";
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
import { Switch } from "@renderer/components/ui/switch";
import { Pcm16Recorder } from "@renderer/lib/pcm16-recorder";

type MessageRole = "user" | "assistant";
type MessageState = "streaming" | "done" | "error";
type ActionKind = "thinking" | "tool" | "approval" | "status" | "error";

interface ConsoleMessage {
  id: string;
  requestId: string;
  role: MessageRole;
  text: string;
  state: MessageState;
}

interface ActionItem {
  id: string;
  requestId: string;
  kind: ActionKind;
  label: string;
  detail: string;
  timestamp: string;
}

interface PendingApproval {
  requestId: string;
  approvalId: string;
  toolName: string;
  description: string;
}

function historyRoleToMessageRole(role: HistoryMessage["role"]): MessageRole {
  return role === "assistant" ? "assistant" : "user";
}

const APPROVAL_OPTIONS: Array<{ decision: CommandApprovalDecision; label: string }> = [
  { decision: "allow-once", label: "同意一次" },
  { decision: "allow-always", label: "同意并记住" },
  { decision: "deny", label: "拒绝" }
];

function makeId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function summarize(value: unknown, maxLength = 240): string {
  let text = "";
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }

  const normalized = text.trim();
  if (!normalized) {
    return "(空)";
  }

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function singleLine(value: string, maxLength = 108): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "(空)";
  }

  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function isAlibabaSttReady(config: AppConfig | null): boolean {
  if (!config) {
    return false;
  }

  return config.alibabaVoice.enabled && config.alibabaVoice.apiKey.trim().length > 0;
}

function appendRecognizedText(currentDraft: string, recognizedText: string): string {
  const normalized = recognizedText.trim();
  if (!normalized) {
    return currentDraft;
  }

  const current = currentDraft.trim();
  if (!current) {
    return normalized;
  }

  return `${current} ${normalized}`;
}

function actionColor(kind: ActionKind): string {
  if (kind === "thinking") {
    return "border-sky-200 bg-sky-50/90";
  }

  if (kind === "tool") {
    return "border-amber-200 bg-amber-50/90";
  }

  if (kind === "approval") {
    return "border-orange-200 bg-orange-50/90";
  }

  if (kind === "error") {
    return "border-rose-200 bg-rose-50/90";
  }

  return "border-border/70 bg-white/75";
}

export function ConsoleChatPage() {
  const [liveMessages, setLiveMessages] = useState<ConsoleMessage[]>([]);
  const [persistedMessages, setPersistedMessages] = useState<HistoryMessage[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [loadingMoreHistory, setLoadingMoreHistory] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [logEnabled, setLogEnabled] = useState(false);
  const [draft, setDraft] = useState("");
  const [sttReady, setSttReady] = useState(false);
  const [micState, setMicState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [micHint, setMicHint] = useState("");
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [approvalIndex, setApprovalIndex] = useState(0);
  const [expandedActions, setExpandedActions] = useState<Record<string, boolean>>({});

  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const actionBottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const loadingMoreHistoryRef = useRef(false);
  const recorderRef = useRef<Pcm16Recorder | null>(null);

  const appendAction = useCallback((item: Omit<ActionItem, "id"> & { id?: string }) => {
    if (!logEnabled) {
      return;
    }

    setActions((prev) => {
      const nextItem: ActionItem = {
        ...item,
        id: item.id ?? makeId("action")
      };

      return [...prev, nextItem].slice(-90);
    });
  }, [logEnabled]);

  const upsertAssistantMessage = useCallback((requestId: string, updater: (current: ConsoleMessage) => ConsoleMessage) => {
    setLiveMessages((prev) => {
      const index = prev.findIndex((item) => item.requestId === requestId && item.role === "assistant");

      if (index < 0) {
        const seed: ConsoleMessage = {
          id: makeId("assistant"),
          requestId,
          role: "assistant",
          text: "",
          state: "streaming"
        };
        return [...prev, updater(seed)];
      }

      const next = [...prev];
      next[index] = updater(next[index]);
      return next;
    });
  }, []);

  const handleChatEvent = useCallback((event: ConsoleRunEventV2) => {
    if (event.type === "thinking") {
      appendAction({
        requestId: event.requestId,
        kind: "thinking",
        label: event.state === "start" ? "开始思考" : "思考完成",
        detail: event.state === "start" ? "模型开始规划动作" : "模型已结束本轮思考",
        timestamp: event.timestamp
      });
      return;
    }

    if (event.type === "text-delta") {
      upsertAssistantMessage(event.requestId, (current) => ({
        ...current,
        text: `${current.text}${event.delta}`,
        state: "streaming"
      }));
      return;
    }

    if (event.type === "tool-call") {
      appendAction({
        requestId: event.requestId,
        kind: "tool",
        label: `调用工具 · ${event.toolName}`,
        detail: summarize(event.input),
        timestamp: event.timestamp
      });
      return;
    }

    if (event.type === "tool-result") {
      appendAction({
        requestId: event.requestId,
        kind: event.success ? "tool" : "error",
        label: event.success ? `工具返回 · ${event.toolName}` : `工具失败 · ${event.toolName}`,
        detail: event.success ? summarize(event.output) : event.error ?? "执行失败",
        timestamp: event.timestamp
      });
      return;
    }

    if (event.type === "approval-request") {
      setPendingApproval({
        requestId: event.requestId,
        approvalId: event.approvalId,
        toolName: event.toolName,
        description: event.description
      });
      setApprovalIndex(0);
      appendAction({
        requestId: event.requestId,
        kind: "approval",
        label: `等待授权 · ${event.toolName}`,
        detail: event.description,
        timestamp: event.timestamp
      });
      return;
    }

    if (event.type === "approval-decision") {
      setPendingApproval((current) => (current?.approvalId === event.approvalId ? null : current));
      appendAction({
        requestId: event.requestId,
        kind: event.decision === "deny" ? "error" : "approval",
        label:
          event.decision === "allow-always"
            ? "已同意并记住"
            : event.decision === "allow-once"
              ? "已同意一次"
              : "已拒绝",
        detail: `审批单 ${event.approvalId.slice(0, 8)}`,
        timestamp: event.timestamp
      });
      return;
    }

    if (event.type === "final") {
      setActiveRequestId((current) => (current === event.requestId ? null : current));
      setPendingApproval((current) => (current?.requestId === event.requestId ? null : current));
      upsertAssistantMessage(event.requestId, (current) => ({
        ...current,
        text: event.displayText || current.text || "操作已完成。",
        state: "done"
      }));
      appendAction({
        requestId: event.requestId,
        kind: "status",
        label: "本轮输出完成",
        detail: "最终答案已写入聊天记录",
        timestamp: event.timestamp
      });
      return;
    }

    setActiveRequestId((current) => (current === event.requestId ? null : current));
    setPendingApproval((current) => (current?.requestId === event.requestId ? null : current));
    upsertAssistantMessage(event.requestId, (current) => ({
      ...current,
      text: event.message,
      state: "error"
    }));
    appendAction({
      requestId: event.requestId,
      kind: "error",
      label: "执行异常",
      detail: event.message,
      timestamp: event.timestamp
    });
  }, [appendAction, upsertAssistantMessage]);

  const loadLatestHistory = useCallback(async () => {
    try {
      const page = await window.companion.listConsoleHistory({
        limit: 20
      });

      setPersistedMessages(page.items);
      setHistoryHasMore(page.hasMore);
      setHistoryCursor(page.nextCursor);
    } finally {
      setHistoryLoaded(true);
    }
  }, []);

  const refreshSttAvailability = useCallback(async (): Promise<boolean> => {
    try {
      const config = await window.companion.getConfig();
      const ready = isAlibabaSttReady(config);
      setSttReady(ready);
      return ready;
    } catch {
      setSttReady(false);
      return false;
    }
  }, []);

  const startMicRecording = useCallback(async () => {
    if (micState !== "idle") {
      return;
    }

    const ready = await refreshSttAvailability();
    if (!ready) {
      setMicHint("阿里语音识别未启用，请先在设置里打开开关并填写 API Key。");
      return;
    }

    try {
      const recorder = new Pcm16Recorder();
      await recorder.start();
      recorderRef.current = recorder;
      setMicState("recording");
      setMicHint("录音中，再点一次结束。");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "无法启动录音，请检查麦克风权限。";
      setMicHint(message);
      setMicState("idle");
    }
  }, [micState, refreshSttAvailability]);

  const stopMicRecording = useCallback(async () => {
    if (micState !== "recording") {
      return;
    }

    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (!recorder) {
      setMicState("idle");
      return;
    }

    setMicState("transcribing");
    setMicHint("正在识别语音...");
    try {
      const captured = await recorder.stop(16_000);
      if (!captured.pcm16Base64 || captured.durationMs < 280) {
        setMicHint("录音太短，未识别到有效语音。");
        return;
      }

      const transcribed = await window.companion.transcribeVoice({
        pcm16Base64: captured.pcm16Base64,
        sampleRate: captured.sampleRate
      });

      const recognizedText = transcribed.text.trim();
      if (!recognizedText) {
        setMicHint("未识别到有效语音。");
        return;
      }

      setDraft((current) => appendRecognizedText(current, recognizedText));
      setMicHint("识别完成，按回车发送。");
    } catch (error) {
      const message = error instanceof Error ? error.message : "语音识别失败，请稍后重试。";
      setMicHint(message);
    } finally {
      setMicState("idle");
    }
  }, [micState]);

  const toggleMicRecording = useCallback(() => {
    if (micState === "recording") {
      void stopMicRecording();
      return;
    }

    if (micState === "idle") {
      void startMicRecording();
    }
  }, [micState, startMicRecording, stopMicRecording]);

  const clearHistory = useCallback(async () => {
    if (activeRequestId || clearingHistory) {
      return;
    }

    const confirmed = window.confirm("确认清空全部历史记录吗？该操作不可撤销。");
    if (!confirmed) {
      return;
    }

    setClearingHistory(true);
    try {
      await window.companion.clearHistory();
      setPersistedMessages([]);
      setLiveMessages([]);
      setHistoryHasMore(false);
      setHistoryCursor(null);
      setActions([]);
      setExpandedActions({});
      setPendingApproval(null);
      appendAction({
        requestId: "history-cleared",
        kind: "status",
        label: "历史已清空",
        detail: "全部对话历史记录已删除。",
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      appendAction({
        requestId: "history-clear-error",
        kind: "error",
        label: "清空失败",
        detail: error instanceof Error ? error.message : "清空历史记录失败，请稍后重试。",
        timestamp: new Date().toISOString()
      });
    } finally {
      setClearingHistory(false);
    }
  }, [activeRequestId, appendAction, clearingHistory]);

  const clearActionLogs = useCallback(() => {
    setActions([]);
    setExpandedActions({});
  }, []);

  const loadMoreHistory = useCallback(async () => {
    if (!historyHasMore || !historyCursor || loadingMoreHistoryRef.current) {
      return;
    }

    loadingMoreHistoryRef.current = true;
    setLoadingMoreHistory(true);
    const container = chatListRef.current;
    const previousScrollTop = container?.scrollTop ?? 0;
    const previousScrollHeight = container?.scrollHeight ?? 0;

    try {
      const page = await window.companion.listConsoleHistory({
        cursor: historyCursor,
        limit: 20
      });

      if (page.items.length === 0) {
        setHistoryHasMore(false);
        setHistoryCursor(null);
        return;
      }

      setPersistedMessages((prev) => {
        const existingIds = new Set(prev.map((item) => item.id));
        const additions = page.items.filter((item) => !existingIds.has(item.id));
        return additions.length > 0 ? [...additions, ...prev] : prev;
      });

      if (page.nextCursor === historyCursor) {
        setHistoryHasMore(false);
        setHistoryCursor(null);
      } else {
        setHistoryHasMore(page.hasMore);
        setHistoryCursor(page.nextCursor);
      }

      requestAnimationFrame(() => {
        const node = chatListRef.current;
        if (!node) {
          return;
        }

        const nextHeight = node.scrollHeight;
        const delta = Math.max(0, nextHeight - previousScrollHeight);
        node.scrollTop = previousScrollTop + delta;
      });
    } finally {
      loadingMoreHistoryRef.current = false;
      setLoadingMoreHistory(false);
    }
  }, [historyCursor, historyHasMore]);

  const maybeLoadMoreHistory = useCallback(() => {
    const container = chatListRef.current;
    if (!container || !historyLoaded || !historyHasMore || loadingMoreHistoryRef.current) {
      return;
    }

    if (container.scrollTop > 36) {
      return;
    }

    void loadMoreHistory();
  }, [historyHasMore, historyLoaded, loadMoreHistory]);

  const handleChatScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (!event.currentTarget) {
        return;
      }
      maybeLoadMoreHistory();
    },
    [maybeLoadMoreHistory]
  );

  useEffect(() => {
    return window.companion.onConsoleRunEvent((event) => {
      handleChatEvent(event);
    });
  }, [handleChatEvent]);

  useEffect(() => {
    void loadLatestHistory();
  }, [loadLatestHistory]);

  useEffect(() => {
    void refreshSttAvailability();
  }, [refreshSttAvailability]);

  useEffect(() => {
    if (!sttReady && micState === "idle") {
      setMicHint("阿里语音识别未启用，请先到设置页开启并填写 API Key。");
      return;
    }

    if (sttReady && micState === "idle" && micHint.startsWith("阿里语音识别未启用")) {
      setMicHint("");
    }
  }, [micHint, micState, sttReady]);

  useEffect(() => {
    if (!historyLoaded) {
      return;
    }

    chatBottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [historyLoaded]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [liveMessages]);

  useEffect(() => {
    actionBottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [actions]);

  useEffect(() => {
    if (!pendingApproval) {
      return;
    }

    inputRef.current?.focus();
  }, [pendingApproval]);

  useEffect(() => {
    return () => {
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) {
        void recorder.cancel();
      }
    };
  }, []);

  const submitApproval = useCallback(async (decision: CommandApprovalDecision) => {
    if (!pendingApproval) {
      return;
    }

    const approval = pendingApproval;
    setPendingApproval(null);
    setApprovalIndex(0);

    await window.companion.approveConsoleCommand({
      approvalId: approval.approvalId,
      decision
    });
  }, [pendingApproval]);

  const handleSubmit = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const text = draft.trim();
    if (!text || activeRequestId) {
      return;
    }

    setDraft("");
    setLiveMessages((prev) => [
      ...prev,
      {
        id: makeId("user"),
        requestId: makeId("request-local"),
        role: "user",
        text,
        state: "done"
      }
    ]);

    try {
      const started = await window.companion.sendConsoleChat(text);
      setActiveRequestId(started.requestId);
      setLiveMessages((prev) => [
        ...prev,
        {
          id: makeId("assistant"),
          requestId: started.requestId,
          role: "assistant",
          text: "",
          state: "streaming"
        }
      ]);
      appendAction({
        requestId: started.requestId,
        kind: "status",
        label: "消息已提交",
        detail: "Yobi 正在流式生成回复",
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "提交请求失败，请稍后重试";
      setLiveMessages((prev) => [
        ...prev,
        {
          id: makeId("assistant"),
          requestId: makeId("request-error"),
          role: "assistant",
          text: message,
          state: "error"
        }
      ]);
      appendAction({
        requestId: "request-error",
        kind: "error",
        label: "提交失败",
        detail: message,
        timestamp: new Date().toISOString()
      });
    }
  }, [activeRequestId, appendAction, draft]);

  const handleInputKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!pendingApproval) {
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setApprovalIndex((current) =>
        current <= 0 ? APPROVAL_OPTIONS.length - 1 : current - 1
      );
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setApprovalIndex((current) =>
        current >= APPROVAL_OPTIONS.length - 1 ? 0 : current + 1
      );
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      void submitApproval(APPROVAL_OPTIONS[approvalIndex]?.decision ?? "allow-once");
    }
  }, [approvalIndex, pendingApproval, submitApproval]);

  const busy = activeRequestId !== null;
  const recording = micState === "recording";
  const transcribing = micState === "transcribing";
  const inputDisabled = (busy && !pendingApproval) || transcribing;
  const micButtonDisabled =
    (pendingApproval !== null && !recording) ||
    transcribing ||
    busy ||
    (!sttReady && !recording);
  const micButtonLabel = transcribing ? "识别中" : recording ? "结束" : "语音";
  const messages = useMemo<ConsoleMessage[]>(() => {
    const historyMessages = persistedMessages
      .filter((item) => item.role === "user" || item.role === "assistant")
      .map((item) => ({
        id: item.id,
        requestId: `history-${item.id}`,
        role: historyRoleToMessageRole(item.role),
        text: item.text,
        state: "done" as const
      }));

    return [...historyMessages, ...liveMessages];
  }, [persistedMessages, liveMessages]);

  const isToolAction = useCallback((item: ActionItem): boolean => {
    if (item.kind === "tool") {
      return true;
    }

    return (
      item.label.startsWith("调用工具") ||
      item.label.startsWith("工具返回") ||
      item.label.startsWith("工具失败")
    );
  }, []);

  return (
    <div className="grid h-[calc(100vh-140px)] min-h-[680px] max-h-[900px] gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Card className="flex h-full min-h-0 flex-col overflow-hidden">
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>对话窗口</CardTitle>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void clearHistory()}
            disabled={busy || clearingHistory || !historyLoaded}
            className="border-rose-200 text-rose-700 hover:border-rose-300 hover:bg-rose-50"
          >
            {clearingHistory ? "清空中..." : "清空历史记录"}
          </Button>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
          <div
            ref={chatListRef}
            className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-2"
            onScroll={handleChatScroll}
          >
            {historyLoaded && historyHasMore ? (
              <div className="flex justify-center">
                <span className="rounded-full border border-border/70 bg-white/75 px-3 py-1 text-xs text-muted-foreground">
                  {loadingMoreHistory ? "正在加载更早消息..." : "上滑到顶部自动加载历史消息"}
                </span>
              </div>
            ) : null}

            {!historyLoaded ? (
              <p className="rounded-lg border border-dashed border-border/70 bg-white/55 px-3 py-4 text-sm text-muted-foreground">
                正在加载历史消息...
              </p>
            ) : messages.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border/70 bg-white/55 px-3 py-4 text-sm text-muted-foreground">
                暂无对话记录，发一条消息开始聊天吧。
              </p>
            ) : (
              messages.map((item) => (
                <div
                  key={item.id}
                  className={
                    item.role === "user"
                      ? "ml-auto w-fit max-w-[80%] rounded-2xl bg-primary px-4 py-3 text-sm text-primary-foreground"
                      : `mr-auto w-fit max-w-[88%] rounded-2xl border px-4 py-3 text-sm ${
                          item.state === "error"
                            ? "border-rose-200 bg-rose-50 text-rose-900"
                            : "border-border/80 bg-white/88 text-foreground"
                        }`
                  }
                >
                  <p className="whitespace-pre-wrap leading-relaxed">{item.text || "..."}</p>
                  {item.role === "assistant" && item.state === "streaming" ? (
                    <p className="mt-2 text-xs text-muted-foreground">流式输出中...</p>
                  ) : null}
                </div>
              ))
            )}
            <div ref={chatBottomRef} />
          </div>

          <div className="relative border-t border-border/70 pt-4">
            {pendingApproval ? (
              <div className="absolute bottom-full left-0 right-0 mb-2 rounded-xl border border-orange-300 bg-orange-50/95 p-3 shadow-lg">
                <p className="text-sm font-medium text-orange-950">需要确认命令：{pendingApproval.toolName}</p>
                <p className="mt-1 whitespace-pre-wrap text-xs text-orange-900/90">
                  {pendingApproval.description}
                </p>

                <div className="mt-2 grid gap-1">
                  {APPROVAL_OPTIONS.map((item, index) => (
                    <button
                      key={item.decision}
                      type="button"
                      onClick={() => {
                        setApprovalIndex(index);
                        void submitApproval(item.decision);
                      }}
                      className={`rounded-md border px-2 py-1.5 text-left text-xs transition ${
                        approvalIndex === index
                          ? "border-orange-500 bg-orange-200/80 text-orange-950"
                          : "border-orange-200 bg-white/80 text-orange-900 hover:bg-orange-100"
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <form onSubmit={handleSubmit} className="flex gap-2">
              <Input
                ref={inputRef}
                value={draft}
                placeholder="和 Yobi 说点什么"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleInputKeyDown}
                disabled={inputDisabled}
              />
              <Button
                type="button"
                variant="outline"
                onClick={toggleMicRecording}
                disabled={micButtonDisabled}
                className={`h-11 min-w-[88px] shrink-0 whitespace-nowrap ${
                  recording ? "border-rose-400 text-rose-700 hover:border-rose-500 hover:bg-rose-50" : ""
                }`}
                title={
                  sttReady
                    ? "单击开始录音，再次单击结束识别"
                    : "请先在设置里启用阿里语音并填写 API Key"
                }
              >
                {transcribing ? (
                  <>
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    {micButtonLabel}
                  </>
                ) : recording ? (
                  <>
                    <Square className="mr-1.5 h-4 w-4" />
                    {micButtonLabel}
                  </>
                ) : (
                  <>
                    <Mic className="mr-1.5 h-4 w-4" />
                    {micButtonLabel}
                  </>
                )}
              </Button>
              <Button
                type="submit"
                disabled={busy || recording || transcribing || draft.trim().length === 0}
                className="h-11 min-w-[92px] shrink-0 whitespace-nowrap"
              >
                {busy ? "处理中..." : "发送"}
              </Button>
            </form>
            {micHint ? (
              <p className="mt-2 text-xs text-muted-foreground">{micHint}</p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card className="flex h-full min-h-0 flex-col overflow-hidden">
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>动作日志</CardTitle>
            <CardDescription>
              {logEnabled ? "记录 Thinking、工具命令、审批与错误。" : "日志采集已关闭（可随时恢复）。"}
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="whitespace-nowrap text-xs text-muted-foreground">记录</span>
            <Switch
              checked={logEnabled}
              onChange={setLogEnabled}
              aria-label="启用动作日志采集"
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0 text-muted-foreground hover:text-rose-600"
              onClick={clearActionLogs}
              disabled={actions.length === 0}
              aria-label="清空动作日志"
              title="清空动作日志"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-hidden">
          <div className="h-full min-h-0 space-y-2 overflow-y-auto pr-1">
            {actions.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border/70 bg-white/55 px-3 py-3 text-xs text-muted-foreground">
                等待模型动作...
              </p>
            ) : (
              actions.map((item) => {
                const expandable = isToolAction(item);
                const expanded = expandedActions[item.id] === true;
                const timestamp = new Date(item.timestamp).toLocaleTimeString();

                if (expandable) {
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
                      className={`w-full rounded-lg border px-3 py-2 text-left text-xs transition hover:brightness-[0.99] ${actionColor(item.kind)}`}
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <Badge>{item.label}</Badge>
                        <span className="text-[11px] text-muted-foreground">{timestamp}</span>
                      </div>
                      <p className={expanded ? "whitespace-pre-wrap leading-relaxed text-foreground/90" : "truncate leading-relaxed text-foreground/90"}>
                        {expanded ? item.detail : singleLine(item.detail)}
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {expanded ? "点击收起" : "点击展开"}
                      </p>
                    </button>
                  );
                }

                return (
                  <div key={item.id} className={`rounded-lg border px-3 py-2 text-xs ${actionColor(item.kind)}`}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <Badge>{item.label}</Badge>
                      <span className="text-[11px] text-muted-foreground">{timestamp}</span>
                    </div>
                    <p className="whitespace-pre-wrap leading-relaxed text-foreground/90">{item.detail}</p>
                  </div>
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
