import { useCallback, useEffect, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent, FormEvent, KeyboardEvent, RefObject, UIEvent } from "react";
import type {
  CompanionModeEvent,
  CompanionModeState,
  CommandApprovalDecision,
  ConsoleChatAttachmentInput,
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
import { buildConsoleChatRequestPayload } from "@shared/console-chat-request";
import {
  reconcileTransientConsoleChatFeedMessages,
  updateAssistantConsoleChatFeedMessageIfPresent,
  upsertAssistantConsoleChatFeedMessage
} from "@shared/console-chat-feed";
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
  CONSOLE_HISTORY_INITIAL_LIMIT,
  appendRecognizedText,
  historyRoleToMessageRole,
  toConsoleAttachmentView
} from "./types";
import type {
  ConsoleActivatedSkill,
  ConsoleAttachmentView,
  ConsoleMessage,
  ConsoleSkillsCatalogState,
  PendingApproval
} from "./types";

export interface ConsoleChatController {
  messages: ConsoleMessage[];
  draft: string;
  setDraft: (value: string) => void;
  composerAttachments: ConsoleAttachmentView[];
  micState: "idle" | "recording" | "transcribing";
  micHint: string;
  activeRequestId: string | null;
  taskMode: boolean;
  setTaskMode: (value: boolean) => void;
  pendingApproval: PendingApproval | null;
  skillsCatalog: ConsoleSkillsCatalogState | null;
  activatedSkills: ConsoleActivatedSkill[];
  approvalIndex: number;
  setApprovalIndex: (index: number) => void;
  historyLoaded: boolean;
  clearingHistory: boolean;
  busy: boolean;
  recording: boolean;
  transcribing: boolean;
  inputDisabled: boolean;
  micButtonDisabled: boolean;
  micButtonLabel: string;
  stoppingRequest: boolean;
  voiceSession: VoiceSessionState | null;
  companionModeState: CompanionModeState | null;
  pendingVoiceContext: VoiceInputContext | null;
  toggleVoiceSession: () => Promise<void>;
  toggleCompanionMode: () => Promise<void>;
  interruptVoiceSession: () => Promise<void>;
  chatBottomRef: RefObject<HTMLDivElement | null>;
  chatListRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  clearHistory: () => Promise<void>;
  handleChatScroll: (event: UIEvent<HTMLDivElement>) => void;
  handleSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  handleAttachmentSelection: (files: FileList | File[]) => Promise<void>;
  removeComposerAttachment: (attachmentId: string) => void;
  stopCurrentRequest: () => Promise<void>;
  handleInputKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  handleInputPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  handleComposerDrop: (event: DragEvent<HTMLFormElement>) => void;
  handleComposerDragOver: (event: DragEvent<HTMLFormElement>) => void;
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
    attachments: item.meta?.attachments?.map((attachment) => toConsoleAttachmentView(attachment)),
    source: item.meta?.source,
    historyMode: item.role === "assistant",
    process:
      item.role === "assistant"
        ? createAssistantTurnProcess({
            timeline: item.meta?.assistantTimeline?.blocks
          })
        : undefined
  };
}

function createAssistantErrorMessage(message: string): ConsoleMessage {
  return {
    id: makeClientId("assistant"),
    requestId: makeClientId("request-error"),
    role: "assistant",
    text: message,
    state: "error",
    process: createAssistantTurnProcess()
  };
}

function toDataUrl(mimeType: string | undefined, dataBase64: string): string {
  return `data:${mimeType || "application/octet-stream"};base64,${dataBase64}`;
}

async function fileToConsoleAttachment(file: File): Promise<ConsoleAttachmentView> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  const dataBase64 = window.btoa(binary);
  const mimeType = file.type || "application/octet-stream";
  const input: ConsoleChatAttachmentInput = {
    name: file.name,
    mimeType,
    size: file.size,
    dataBase64
  };

  return {
    id: makeClientId("attachment"),
    kind: mimeType.startsWith("image/") ? "image" : "file",
    filename: file.name || "attachment",
    mimeType,
    size: file.size,
    previewUrl: toDataUrl(mimeType, dataBase64),
    source: "draft",
    input
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

export function useConsoleChatController(): ConsoleChatController {
  const [messages, setMessages] = useState<ConsoleMessage[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [draft, setDraft] = useState("");
  const [composerAttachments, setComposerAttachments] = useState<ConsoleAttachmentView[]>([]);
  const [micState, setMicState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [micHint, setMicHint] = useState("");
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [taskMode, setTaskMode] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [skillsCatalog, setSkillsCatalog] = useState<ConsoleSkillsCatalogState | null>(null);
  const [activatedSkills, setActivatedSkills] = useState<ConsoleActivatedSkill[]>([]);
  const [approvalIndex, setApprovalIndex] = useState(0);
  const [stoppingRequestId, setStoppingRequestId] = useState<string | null>(null);
  const [voiceSession, setVoiceSession] = useState<VoiceSessionState | null>(null);
  const [companionModeState, setCompanionModeState] = useState<CompanionModeState | null>(null);
  const [pendingVoiceContext, setPendingVoiceContext] = useState<VoiceInputContext | null>(null);

  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const autoFollowRef = useRef(true);
  const recorderRef = useRef<Pcm16Recorder | null>(null);
  const liveVoiceStateRef = useRef(createConsoleChatLiveVoiceState());

  const pushAssistantError = useCallback((message: string) => {
    setMessages((current) => [...current, createAssistantErrorMessage(message)]);
  }, []);

  const upsertAssistantMessage = useCallback(
    (requestId: string, updater: (current: ConsoleMessage) => ConsoleMessage) => {
      setMessages((current) =>
        upsertAssistantConsoleChatFeedMessage(
          current,
          requestId,
          updater,
          createStreamingAssistantMessage
        )
      );
    },
    []
  );

  const updateAssistantMessageIfPresent = useCallback(
    (requestId: string, updater: (current: ConsoleMessage) => ConsoleMessage | null) => {
      setMessages((current) =>
        updateAssistantConsoleChatFeedMessageIfPresent(current, requestId, updater)
      );
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
        setMessages((current) => [
          ...current,
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
        limit: CONSOLE_HISTORY_INITIAL_LIMIT
      });

      setMessages(
        page.items
          .filter((item) => item.role === "user" || item.role === "assistant")
          .map((item) => createHistoryMessage(item))
      );
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
    if (!historyLoaded || micState !== "idle") {
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
  }, [checkSttAvailability, historyLoaded, micState]);

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
    setMessages((current) =>
      reconcileTransientConsoleChatFeedMessages(
        current,
        nextVoiceState.messages.map((message) => createTransientVoiceMessage(message))
      )
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
      setMessages([]);
      setComposerAttachments([]);
      setPendingApproval(null);
    } finally {
      setClearingHistory(false);
    }
  }, [activeRequestId, clearingHistory]);

  const handleChatScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (!event.currentTarget) {
        return;
      }

      autoFollowRef.current = getNextConsoleChatAutoFollowState({
        type: "user-scroll",
        metrics: readScrollMetrics(event.currentTarget)
      });
    },
    []
  );

  useEffect(() => {
    if (!historyLoaded) {
      return;
    }

    return window.companion.onConsoleRunEvent((event) => {
      handleChatEvent(event);
    });
  }, [handleChatEvent, historyLoaded]);

  useEffect(() => {
    if (!historyLoaded) {
      return;
    }

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
  }, [applyVoiceSessionEvent, historyLoaded]);

  useEffect(() => {
    if (!historyLoaded) {
      return;
    }

    const applyCompanionEvent = (event: CompanionModeEvent) => {
      if (event.type === "state") {
        setCompanionModeState(event.state);
      }
    };

    void window.companion.getCompanionModeState().then((state) => {
      setCompanionModeState(state);
    }).catch(() => undefined);

    return window.companion.onCompanionModeEvent((event) => {
      applyCompanionEvent(event);
    });
  }, [historyLoaded]);

  const toggleVoiceSession = useCallback(async () => {
    if (!historyLoaded) {
      return;
    }

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
  }, [applyVoiceSessionEvent, historyLoaded, voiceSession?.sessionId]);

  const interruptVoiceSession = useCallback(async () => {
    await window.companion.interruptVoiceSession({
      reason: "manual"
    });
  }, []);

  const toggleCompanionMode = useCallback(async () => {
    if (!historyLoaded) {
      return;
    }

    const next = companionModeState?.active
      ? await window.companion.stopCompanionMode()
      : await window.companion.startCompanionMode();
    setCompanionModeState(next);
  }, [companionModeState?.active, historyLoaded]);

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
  }, [messages]);

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

  const handleAttachmentSelection = useCallback(
    async (files: FileList | File[]) => {
      const selected = Array.from(files);
      if (selected.length === 0) {
        return;
      }

      const availableSlots = Math.max(0, 3 - composerAttachments.length);
      if (availableSlots <= 0) {
        pushAssistantError("单条消息最多只能附加 3 个文件。");
        return;
      }

      try {
        const nextAttachments = await Promise.all(selected.slice(0, availableSlots).map((file) => fileToConsoleAttachment(file)));
        setComposerAttachments((current) => [...current, ...nextAttachments]);
        if (selected.length > availableSlots) {
          pushAssistantError("超出 3 个附件上限，已忽略多余文件。");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取附件失败，请重试。";
        pushAssistantError(message);
      }
    },
    [composerAttachments.length, pushAssistantError]
  );

  const removeComposerAttachment = useCallback((attachmentId: string) => {
    setComposerAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
  }, []);

  const handleInputPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (event.clipboardData.files.length === 0) {
        return;
      }

      event.preventDefault();
      void handleAttachmentSelection(event.clipboardData.files);
    },
    [handleAttachmentSelection]
  );

  const handleComposerDragOver = useCallback((event: DragEvent<HTMLFormElement>) => {
    if (event.dataTransfer.files.length === 0) {
      return;
    }

    event.preventDefault();
  }, []);

  const handleComposerDrop = useCallback(
    (event: DragEvent<HTMLFormElement>) => {
      if (event.dataTransfer.files.length === 0) {
        return;
      }

      event.preventDefault();
      void handleAttachmentSelection(event.dataTransfer.files);
    },
    [handleAttachmentSelection]
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const text = draft.trim();
      if (!historyLoaded || (!text && composerAttachments.length === 0) || activeRequestId) {
        return;
      }

      const attachments = composerAttachments;
      const attachmentInputs = attachments
        .map((attachment) => attachment.input)
        .filter((attachment): attachment is ConsoleChatAttachmentInput => Boolean(attachment));
      setDraft("");
      setComposerAttachments([]);
      setSkillsCatalog(null);
      setActivatedSkills([]);
      autoFollowRef.current = getNextConsoleChatAutoFollowState({
        type: "submit-message"
      });
      const localRequestId = makeClientId("request-local");
      setMessages((current) => [
        ...current,
        {
          id: makeClientId("user"),
          requestId: localRequestId,
          role: "user",
          text,
          state: "done",
          attachments: attachments.map(({ input, ...attachment }) => attachment)
        }
      ]);

      try {
        const requestPayload = buildConsoleChatRequestPayload({
          text,
          attachments: attachmentInputs,
          voiceContext: pendingVoiceContext ?? undefined,
          taskMode
        });
        const started = pendingVoiceContext
          ? await window.companion.sendConsoleChatWithVoice(requestPayload)
          : await window.companion.sendConsoleChat(requestPayload);
        setActiveRequestId(started.requestId);
        setPendingVoiceContext(null);
        setMessages((current) => {
          if (
            current.some(
              (item) => item.requestId === started.requestId && item.role === "assistant"
            )
          ) {
            return current;
          }

          return [...current, createStreamingAssistantMessage(started.requestId)];
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "提交请求失败，请稍后重试";
        setMessages((current) =>
          current.filter((item) => item.requestId !== localRequestId)
        );
        setDraft(text);
        setComposerAttachments(attachments);
        pushAssistantError(message);
      }
    },
    [
      activeRequestId,
      composerAttachments,
      draft,
      historyLoaded,
      pendingVoiceContext,
      pushAssistantError,
      taskMode
    ]
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
  const inputDisabled = !historyLoaded || (busy && !pendingApproval) || transcribing;
  const micButtonDisabled = !historyLoaded || shouldDisableConsoleMicButton({
    pendingApproval: pendingApproval !== null,
    recording,
    transcribing,
    busy
  });
  const micButtonLabel = transcribing ? "识别中" : recording ? "结束" : "语音";
  const stoppingRequest = stoppingRequestId !== null && stoppingRequestId === activeRequestId;

  return {
    messages,
    draft,
    setDraft,
    composerAttachments,
    micState,
    micHint,
    activeRequestId,
    taskMode,
    setTaskMode,
    pendingApproval,
    skillsCatalog,
    activatedSkills,
    approvalIndex,
    setApprovalIndex,
    historyLoaded,
    clearingHistory,
    busy,
    recording,
    transcribing,
    inputDisabled,
    micButtonDisabled,
    micButtonLabel,
    stoppingRequest,
    voiceSession,
    companionModeState,
    pendingVoiceContext,
    toggleVoiceSession,
    toggleCompanionMode,
    interruptVoiceSession,
    chatBottomRef,
    chatListRef,
    inputRef,
    clearHistory,
    handleChatScroll,
    handleSubmit,
    handleAttachmentSelection,
    removeComposerAttachment,
    stopCurrentRequest,
    handleInputKeyDown,
    handleInputPaste,
    handleComposerDrop,
    handleComposerDragOver,
    toggleMicRecording,
    submitApproval
  };
}
