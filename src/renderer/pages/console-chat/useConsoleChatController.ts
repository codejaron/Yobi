import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, UIEvent } from "react";
import type { CommandApprovalDecision, ConsoleRunEventV2, HistoryMessage } from "@shared/types";
import { Pcm16Recorder } from "@renderer/lib/pcm16-recorder";
import { makeClientId, summarizeUnknown } from "@renderer/pages/chat-utils";
import {
  APPROVAL_OPTIONS,
  CONSOLE_HISTORY_PAGE_SIZE,
  LIVE_MESSAGE_LIMIT,
  appendRecognizedText,
  historyRoleToMessageRole,
  isAlibabaSttReady
} from "./types";
import type { ActionItem, ConsoleMessage, PendingApproval } from "./types";

export interface ConsoleChatController {
  messages: ConsoleMessage[];
  actions: ActionItem[];
  logEnabled: boolean;
  setLogEnabled: (enabled: boolean) => void;
  draft: string;
  setDraft: (value: string) => void;
  sttReady: boolean;
  micState: "idle" | "recording" | "transcribing";
  micHint: string;
  activeRequestId: string | null;
  pendingApproval: PendingApproval | null;
  approvalIndex: number;
  setApprovalIndex: (index: number) => void;
  expandedActions: Record<string, boolean>;
  historyLoaded: boolean;
  historyHasMore: boolean;
  loadingMoreHistory: boolean;
  clearingHistory: boolean;
  busy: boolean;
  recording: boolean;
  transcribing: boolean;
  inputDisabled: boolean;
  micButtonDisabled: boolean;
  micButtonLabel: string;
  chatBottomRef: React.RefObject<HTMLDivElement | null>;
  chatListRef: React.RefObject<HTMLDivElement | null>;
  actionBottomRef: React.RefObject<HTMLDivElement | null>;
  inputRef: React.RefObject<HTMLInputElement | null>;
  clearHistory: () => Promise<void>;
  clearActionLogs: () => void;
  toggleActionExpanded: (id: string) => void;
  handleChatScroll: (event: UIEvent<HTMLDivElement>) => void;
  handleSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  handleInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  toggleMicRecording: () => void;
  submitApproval: (decision: CommandApprovalDecision) => Promise<void>;
  isToolAction: (item: ActionItem) => boolean;
}

export function useConsoleChatController(): ConsoleChatController {
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
        id: item.id ?? makeClientId("action")
      };

      return [...prev, nextItem].slice(-LIVE_MESSAGE_LIMIT);
    });
  }, [logEnabled]);

  const upsertAssistantMessage = useCallback((requestId: string, updater: (current: ConsoleMessage) => ConsoleMessage) => {
    setLiveMessages((prev) => {
      const index = prev.findIndex((item) => item.requestId === requestId && item.role === "assistant");

      if (index < 0) {
        const seed: ConsoleMessage = {
          id: makeClientId("assistant"),
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
        detail: summarizeUnknown(event.input),
        timestamp: event.timestamp
      });
      return;
    }

    if (event.type === "tool-result") {
      appendAction({
        requestId: event.requestId,
        kind: event.success ? "tool" : "error",
        label: event.success ? `工具返回 · ${event.toolName}` : `工具失败 · ${event.toolName}`,
        detail: event.success ? summarizeUnknown(event.output) : event.error ?? "执行失败",
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

    if (event.type === "external-assistant-message") {
      setLiveMessages((prev) => [
        ...prev,
        {
          id: event.messageId,
          requestId: event.requestId,
          role: "assistant",
          text: event.text,
          state: "done",
          source: event.source
        }
      ]);
      appendAction({
        requestId: event.requestId,
        kind: "status",
        label: "Claw 结果已同步",
        detail: "Claw 完成消息已回流到 Yobi 对话。",
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
        limit: CONSOLE_HISTORY_PAGE_SIZE
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

  const toggleActionExpanded = useCallback((id: string) => {
    setExpandedActions((prev) => ({
      ...prev,
      [id]: !prev[id]
    }));
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
        limit: CONSOLE_HISTORY_PAGE_SIZE
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
    (event: UIEvent<HTMLDivElement>) => {
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

  const handleSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const text = draft.trim();
    if (!text || activeRequestId) {
      return;
    }

    setDraft("");
    setLiveMessages((prev) => [
      ...prev,
      {
        id: makeClientId("user"),
        requestId: makeClientId("request-local"),
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
          id: makeClientId("assistant"),
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
          id: makeClientId("assistant"),
          requestId: makeClientId("request-error"),
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

  const handleInputKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
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
        state: "done" as const,
        source: item.meta?.source
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

  return {
    messages,
    actions,
    logEnabled,
    setLogEnabled,
    draft,
    setDraft,
    sttReady,
    micState,
    micHint,
    activeRequestId,
    pendingApproval,
    approvalIndex,
    setApprovalIndex,
    expandedActions,
    historyLoaded,
    historyHasMore,
    loadingMoreHistory,
    clearingHistory,
    busy,
    recording,
    transcribing,
    inputDisabled,
    micButtonDisabled,
    micButtonLabel,
    chatBottomRef,
    chatListRef,
    actionBottomRef,
    inputRef,
    clearHistory,
    clearActionLogs,
    toggleActionExpanded,
    handleChatScroll,
    handleSubmit,
    handleInputKeyDown,
    toggleMicRecording,
    submitApproval,
    isToolAction
  };
}
