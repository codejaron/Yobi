import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, UIEvent } from "react";
import type {
  CommandApprovalDecision,
  ConsoleRunEventV2,
  HistoryMessage,
  VoiceInputContext,
  VoiceSessionEvent,
  VoiceSessionState
} from "@shared/types";
import {
  applyVoiceSessionEventToConsoleChatLiveVoiceState,
  createConsoleChatLiveVoiceState,
  type ConsoleChatLiveVoiceMessage
} from "@shared/console-chat-live-voice";
import {
  applyConsoleEventToAssistantProcess,
  createAssistantTurnProcess,
  hasAssistantVisibleContent
} from "@shared/tool-trace";
import { getNextConsoleChatAutoFollowState } from "@shared/console-chat-scroll";
import { getConsoleComposerKeyAction } from "@shared/console-chat-composer";
import { shouldDisableConsoleMicButton } from "@shared/console-chat-voice";
import { Pcm16Recorder } from "@renderer/lib/pcm16-recorder";
import { makeClientId } from "@renderer/pages/chat-utils";
import {
  APPROVAL_OPTIONS,
  CONSOLE_HISTORY_PAGE_SIZE,
  appendRecognizedText,
  historyRoleToMessageRole
} from "./types";
import type {
  ConsoleActivatedSkill,
  ConsoleMessage,
  ConsoleSkillsCatalogState,
  PendingApproval
} from "./types";

export interface ConsoleChatController {
  messages: ConsoleMessage[];
  draft: string;
  setDraft: (value: string) => void;
  micState: "idle" | "recording" | "transcribing";
  micHint: string;
  activeRequestId: string | null;
  pendingApproval: PendingApproval | null;
  skillsCatalog: ConsoleSkillsCatalogState | null;
  activatedSkills: ConsoleActivatedSkill[];
  approvalIndex: number;
  setApprovalIndex: (index: number) => void;
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
  stoppingRequest: boolean;
  voiceSession: VoiceSessionState | null;
  pendingVoiceContext: VoiceInputContext | null;
  toggleVoiceSession: () => Promise<void>;
  interruptVoiceSession: () => Promise<void>;
  chatBottomRef: React.RefObject<HTMLDivElement | null>;
  chatListRef: React.RefObject<HTMLDivElement | null>;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  clearHistory: () => Promise<void>;
  handleChatScroll: (event: UIEvent<HTMLDivElement>) => void;
  handleSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  stopCurrentRequest: () => Promise<void>;
  handleInputKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  toggleMicRecording: () => void;
  submitApproval: (decision: CommandApprovalDecision) => Promise<void>;
}

function createStreamingAssistantMessage(requestId: string): ConsoleMessage {
  const process = createAssistantTurnProcess();
  process.thinkingVisible = true;

  return {
    id: makeClientId("assistant"),
    requestId,
    role: "assistant",
    text: "",
    state: "streaming",
    process
  };
}

function createHistoryMessage(item: HistoryMessage): ConsoleMessage {
  return {
    id: item.id,
    requestId: `history-${item.id}`,
    role: historyRoleToMessageRole(item.role),
    text: item.text,
    state: "done",
    source: item.meta?.source,
    historyMode: item.role === "assistant",
    process:
      item.role === "assistant"
        ? createAssistantTurnProcess(item.meta?.toolTrace?.items)
        : undefined
  };
}

function readScrollMetrics(node: HTMLDivElement) {
  return {
    scrollTop: node.scrollTop,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight
  };
}

function createTransientVoiceMessage(message: ConsoleChatLiveVoiceMessage): ConsoleMessage {
  return {
    ...message,
    transientOrigin: "voice"
  };
}

function reconcileTransientVoiceMessages(
  current: ConsoleMessage[],
  nextVoiceMessages: ConsoleChatLiveVoiceMessage[]
): ConsoleMessage[] {
  const nextById = new Map(
    nextVoiceMessages.map((message) => [message.id, createTransientVoiceMessage(message)])
  );
  const emitted = new Set<string>();
  const next: ConsoleMessage[] = [];

  for (const message of current) {
    if (message.transientOrigin !== "voice") {
      next.push(message);
      continue;
    }

    const replacement = nextById.get(message.id);
    if (!replacement) {
      continue;
    }

    next.push(replacement);
    emitted.add(message.id);
  }

  for (const message of nextVoiceMessages) {
    if (emitted.has(message.id)) {
      continue;
    }

    next.push(createTransientVoiceMessage(message));
  }

  return next;
}

function dropVoiceMessagesDuplicatedInHistory(
  historyMessages: ConsoleMessage[],
  liveMessages: ConsoleMessage[]
): ConsoleMessage[] {
  const doneVoiceMessages = liveMessages.filter(
    (message) => message.transientOrigin === "voice" && message.state === "done"
  );
  if (doneVoiceMessages.length === 0 || historyMessages.length === 0) {
    return liveMessages;
  }

  let duplicateCount = 0;
  const maxMatchLength = Math.min(doneVoiceMessages.length, historyMessages.length);
  for (let length = 1; length <= maxMatchLength; length += 1) {
    let matches = true;
    for (let index = 0; index < length; index += 1) {
      const liveMessage = doneVoiceMessages[index];
      const historyMessage = historyMessages[historyMessages.length - length + index];
      if (
        liveMessage?.role !== historyMessage?.role ||
        liveMessage?.text !== historyMessage?.text
      ) {
        matches = false;
        break;
      }
    }

    if (matches) {
      duplicateCount = length;
    }
  }

  if (duplicateCount === 0) {
    return liveMessages;
  }

  let remainingDuplicates = duplicateCount;
  return liveMessages.filter((message) => {
    if (
      remainingDuplicates > 0 &&
      message.transientOrigin === "voice" &&
      message.state === "done"
    ) {
      remainingDuplicates -= 1;
      return false;
    }

    return true;
  });
}

export function useConsoleChatController(): ConsoleChatController {
  const [liveMessages, setLiveMessages] = useState<ConsoleMessage[]>([]);
  const [persistedMessages, setPersistedMessages] = useState<HistoryMessage[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [loadingMoreHistory, setLoadingMoreHistory] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [draft, setDraft] = useState("");
  const [micState, setMicState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [micHint, setMicHint] = useState("");
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [skillsCatalog, setSkillsCatalog] = useState<ConsoleSkillsCatalogState | null>(null);
  const [activatedSkills, setActivatedSkills] = useState<ConsoleActivatedSkill[]>([]);
  const [approvalIndex, setApprovalIndex] = useState(0);
  const [stoppingRequestId, setStoppingRequestId] = useState<string | null>(null);
  const [voiceSession, setVoiceSession] = useState<VoiceSessionState | null>(null);
  const [pendingVoiceContext, setPendingVoiceContext] = useState<VoiceInputContext | null>(null);

  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const autoFollowRef = useRef(true);
  const loadingMoreHistoryRef = useRef(false);
  const recorderRef = useRef<Pcm16Recorder | null>(null);
  const liveVoiceStateRef = useRef(createConsoleChatLiveVoiceState());

  const upsertAssistantMessage = useCallback(
    (requestId: string, updater: (current: ConsoleMessage) => ConsoleMessage) => {
      setLiveMessages((prev) => {
        const index = prev.findIndex((item) => item.requestId === requestId && item.role === "assistant");

        if (index < 0) {
          return [...prev, updater(createStreamingAssistantMessage(requestId))];
        }

        const next = [...prev];
        next[index] = updater(next[index]);
        return next;
      });
    },
    []
  );

  const updateAssistantMessageIfPresent = useCallback(
    (requestId: string, updater: (current: ConsoleMessage) => ConsoleMessage | null) => {
      setLiveMessages((prev) => {
        const index = prev.findIndex((item) => item.requestId === requestId && item.role === "assistant");
        if (index < 0) {
          return prev;
        }

        const nextMessage = updater(prev[index]);
        if (!nextMessage) {
          return prev.filter((item) => item.id !== prev[index]?.id);
        }

        const next = [...prev];
        next[index] = nextMessage;
        return next;
      });
    },
    []
  );

  const handleChatEvent = useCallback(
    (event: ConsoleRunEventV2) => {
      if (event.type === "thinking") {
        upsertAssistantMessage(event.requestId, (current) => ({
          ...current,
          process: applyConsoleEventToAssistantProcess(current.process, event)
        }));
        return;
      }

      if (event.type === "text-delta") {
        upsertAssistantMessage(event.requestId, (current) => ({
          ...current,
          text: `${current.text}${event.delta}`,
          state: "streaming",
          process: applyConsoleEventToAssistantProcess(current.process, event)
        }));
        return;
      }

      if (event.type === "tool-call" || event.type === "tool-result") {
        upsertAssistantMessage(event.requestId, (current) => ({
          ...current,
          process: applyConsoleEventToAssistantProcess(current.process, event)
        }));
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
        return;
      }

      if (event.type === "approval-decision") {
        setPendingApproval((current) => (current?.approvalId === event.approvalId ? null : current));
        return;
      }

      if (event.type === "skills-catalog") {
        setSkillsCatalog({
          enabledCount: event.enabledCount,
          truncated: event.truncated,
          truncatedDescriptions: event.truncatedDescriptions,
          omittedSkills: event.omittedSkills
        });
        setActivatedSkills([]);
        return;
      }

      if (event.type === "skill-activated") {
        setActivatedSkills((current) => {
          if (current.some((item) => item.skillId === event.skillId)) {
            return current;
          }

          return [
            ...current,
            {
              skillId: event.skillId,
              name: event.name,
              compatibility: event.compatibility
            }
          ];
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
            source: event.source,
            process: createAssistantTurnProcess()
          }
        ]);
        return;
      }

      if (event.type === "final") {
        setActiveRequestId((current) => (current === event.requestId ? null : current));
        setStoppingRequestId((current) => (current === event.requestId ? null : current));
        setPendingApproval((current) => (current?.requestId === event.requestId ? null : current));
        if (event.finishReason === "aborted") {
          updateAssistantMessageIfPresent(event.requestId, (current) => {
            const nextProcess = applyConsoleEventToAssistantProcess(current.process, event);
            if (!hasAssistantVisibleContent(current.text, nextProcess)) {
              return null;
            }

            return {
              ...current,
              state: "done",
              process: nextProcess
            };
          });
          return;
        }

        upsertAssistantMessage(event.requestId, (current) => ({
          ...current,
          text: event.displayText || current.text || "操作已完成。",
          state: "done",
          process: applyConsoleEventToAssistantProcess(current.process, event)
        }));
        return;
      }

      setActiveRequestId((current) => (current === event.requestId ? null : current));
      setStoppingRequestId((current) => (current === event.requestId ? null : current));
      setPendingApproval((current) => (current?.requestId === event.requestId ? null : current));
      upsertAssistantMessage(event.requestId, (current) => ({
        ...current,
        text: event.message,
        state: "error",
        process: applyConsoleEventToAssistantProcess(current.process, event)
      }));
    },
    [updateAssistantMessageIfPresent, upsertAssistantMessage]
  );

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

  const checkSttAvailability = useCallback(async (): Promise<{
    ready: boolean;
    message: string;
  }> => {
    try {
      const status = await window.companion.getSpeechRecognitionStatus();
      return {
        ready: status.ready,
        message: status.message
      };
    } catch {
      const message = "语音识别状态检查失败，请稍后重试。";
      return {
        ready: false,
        message
      };
    }
  }, []);

  const startMicRecording = useCallback(async () => {
    if (micState !== "idle") {
      return;
    }

    const status = await checkSttAvailability();
    if (!status.ready) {
      setMicHint(status.message);
      return;
    }

    try {
      const recorder = new Pcm16Recorder();
      await recorder.start();
      recorderRef.current = recorder;
      setPendingVoiceContext(null);
      setMicState("recording");
      setMicHint("录音中，再点一次结束。");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "无法启动录音，请检查麦克风权限。";
      setMicHint(message);
      setMicState("idle");
    }
  }, [checkSttAvailability, micState]);

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
      setPendingVoiceContext(
        transcribed.metadata
          ? {
              provider: "sensevoice-local",
              metadata: transcribed.metadata
            }
          : null
      );
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

  const applyVoiceSessionEvent = useCallback((event: VoiceSessionEvent) => {
    if (event.type === "state") {
      setVoiceSession(event.state);
    }

    const nextVoiceState = applyVoiceSessionEventToConsoleChatLiveVoiceState(
      liveVoiceStateRef.current,
      event
    );
    if (nextVoiceState === liveVoiceStateRef.current) {
      return;
    }

    liveVoiceStateRef.current = nextVoiceState;
    setLiveMessages((current) =>
      reconcileTransientVoiceMessages(current, nextVoiceState.messages)
    );
  }, []);

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
      liveVoiceStateRef.current = createConsoleChatLiveVoiceState();
      setPersistedMessages([]);
      setLiveMessages([]);
      setHistoryHasMore(false);
      setHistoryCursor(null);
      setPendingApproval(null);
    } finally {
      setClearingHistory(false);
    }
  }, [activeRequestId, clearingHistory]);

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

      autoFollowRef.current = getNextConsoleChatAutoFollowState({
        type: "user-scroll",
        metrics: readScrollMetrics(event.currentTarget)
      });

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
    void window.companion.getVoiceSessionState().then((state) => {
      applyVoiceSessionEvent({
        type: "state",
        state,
        timestamp: new Date().toISOString()
      });
    }).catch(() => undefined);

    return window.companion.onVoiceSessionEvent((event) => {
      applyVoiceSessionEvent(event);
    });
  }, [applyVoiceSessionEvent]);

  const toggleVoiceSession = useCallback(async () => {
    if (voiceSession?.sessionId) {
      await window.companion.stopVoiceSession();
      return;
    }

    const started = await window.companion.startVoiceSession({
      mode: "free"
    });
    applyVoiceSessionEvent({
      type: "state",
      state: started,
      timestamp: new Date().toISOString()
    });
  }, [applyVoiceSessionEvent, voiceSession?.sessionId]);

  const interruptVoiceSession = useCallback(async () => {
    await window.companion.interruptVoiceSession({
      reason: "manual"
    });
  }, []);

  useEffect(() => {
    void loadLatestHistory();
  }, [loadLatestHistory]);

  useEffect(() => {
    if (!historyLoaded) {
      return;
    }

    autoFollowRef.current = getNextConsoleChatAutoFollowState({
      type: "history-loaded"
    });
    chatBottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [historyLoaded]);

  useEffect(() => {
    if (!autoFollowRef.current) {
      return;
    }

    chatBottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [liveMessages]);

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

  const submitApproval = useCallback(
    async (decision: CommandApprovalDecision) => {
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
    },
    [pendingApproval]
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const text = draft.trim();
      if (!text || activeRequestId) {
        return;
      }

      setDraft("");
      setSkillsCatalog(null);
      setActivatedSkills([]);
      autoFollowRef.current = getNextConsoleChatAutoFollowState({
        type: "submit-message"
      });
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
        const started = pendingVoiceContext
          ? await window.companion.sendConsoleChatWithVoice({
              text,
              voiceContext: pendingVoiceContext
            })
          : await window.companion.sendConsoleChat(text);
        setActiveRequestId(started.requestId);
        setPendingVoiceContext(null);
        setLiveMessages((prev) => {
          if (prev.some((item) => item.requestId === started.requestId && item.role === "assistant")) {
            return prev;
          }

          return [...prev, createStreamingAssistantMessage(started.requestId)];
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
            state: "error",
            process: createAssistantTurnProcess()
          }
        ]);
      }
    },
    [activeRequestId, draft, pendingVoiceContext]
  );

  const stopCurrentRequest = useCallback(async () => {
    if (!activeRequestId || stoppingRequestId === activeRequestId) {
      return;
    }

    const requestId = activeRequestId;
    setStoppingRequestId(requestId);

    try {
      const result = await window.companion.stopConsoleChat(requestId);
      if (result.accepted) {
        setActiveRequestId((current) => (current === requestId ? null : current));
        setPendingApproval((current) => (current?.requestId === requestId ? null : current));
      }
    } finally {
      setStoppingRequestId((current) => (current === requestId ? null : current));
    }
  }, [activeRequestId, stoppingRequestId]);

  const handleInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      const action = getConsoleComposerKeyAction({
        key: event.key,
        shiftKey: event.shiftKey,
        pendingApproval: pendingApproval !== null,
        isComposing: event.nativeEvent.isComposing
      });

      if (action === "approval-up") {
        event.preventDefault();
        setApprovalIndex((current) =>
          current <= 0 ? APPROVAL_OPTIONS.length - 1 : current - 1
        );
        return;
      }

      if (action === "approval-down") {
        event.preventDefault();
        setApprovalIndex((current) =>
          current >= APPROVAL_OPTIONS.length - 1 ? 0 : current + 1
        );
        return;
      }

      if (action === "approval-confirm") {
        event.preventDefault();
        void submitApproval(APPROVAL_OPTIONS[approvalIndex]?.decision ?? "allow-once");
        return;
      }

      if (action === "submit") {
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
      }
    },
    [approvalIndex, pendingApproval, submitApproval]
  );

  const busy = activeRequestId !== null;
  const recording = micState === "recording";
  const transcribing = micState === "transcribing";
  const inputDisabled = (busy && !pendingApproval) || transcribing;
  const micButtonDisabled = shouldDisableConsoleMicButton({
    pendingApproval: pendingApproval !== null,
    recording,
    transcribing,
    busy
  });
  const micButtonLabel = transcribing ? "识别中" : recording ? "结束" : "语音";
  const stoppingRequest = stoppingRequestId !== null && stoppingRequestId === activeRequestId;

  const messages = useMemo<ConsoleMessage[]>(() => {
    const historyMessages = persistedMessages
      .filter((item) => item.role === "user" || item.role === "assistant")
      .map((item) => createHistoryMessage(item));
    const visibleLiveMessages = dropVoiceMessagesDuplicatedInHistory(historyMessages, liveMessages);

    return [...historyMessages, ...visibleLiveMessages];
  }, [persistedMessages, liveMessages]);

  return {
    messages,
    draft,
    setDraft,
    micState,
    micHint,
    activeRequestId,
    pendingApproval,
    skillsCatalog,
    activatedSkills,
    approvalIndex,
    setApprovalIndex,
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
    stoppingRequest,
    voiceSession,
    pendingVoiceContext,
    toggleVoiceSession,
    interruptVoiceSession,
    chatBottomRef,
    chatListRef,
    inputRef,
    clearHistory,
    handleChatScroll,
    handleSubmit,
    stopCurrentRequest,
    handleInputKeyDown,
    toggleMicRecording,
    submitApproval
  };
}
