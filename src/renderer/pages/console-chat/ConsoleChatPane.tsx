import { useLayoutEffect } from "react";
import type { FormEvent, KeyboardEvent, RefObject, UIEvent } from "react";
import type { CommandApprovalDecision, VoiceInputContext, VoiceSessionState } from "@shared/types";
import { Loader2, Mic, Square } from "lucide-react";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { Textarea } from "@renderer/components/ui/textarea";
import { MarkdownContent } from "@renderer/components/chat/MarkdownContent";
import { AssistantProcessView } from "./AssistantProcessView";
import { APPROVAL_OPTIONS } from "./types";
import type {
  ConsoleActivatedSkill,
  ConsoleMessage,
  ConsoleSkillsCatalogState,
  PendingApproval
} from "./types";

interface ConsoleChatPaneProps {
  busy: boolean;
  clearingHistory: boolean;
  historyLoaded: boolean;
  historyHasMore: boolean;
  loadingMoreHistory: boolean;
  messages: ConsoleMessage[];
  chatListRef: RefObject<HTMLDivElement | null>;
  chatBottomRef: RefObject<HTMLDivElement | null>;
  onChatScroll: (event: UIEvent<HTMLDivElement>) => void;
  pendingApproval: PendingApproval | null;
  skillsCatalog: ConsoleSkillsCatalogState | null;
  activatedSkills: ConsoleActivatedSkill[];
  approvalIndex: number;
  setApprovalIndex: (index: number) => void;
  submitApproval: (decision: CommandApprovalDecision) => Promise<void>;
  draft: string;
  setDraft: (value: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  inputDisabled: boolean;
  onInputKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  toggleMicRecording: () => void;
  micButtonDisabled: boolean;
  recording: boolean;
  transcribing: boolean;
  micButtonLabel: string;
  stoppingRequest: boolean;
  voiceSession: VoiceSessionState | null;
  pendingVoiceContext: VoiceInputContext | null;
  toggleVoiceSession: () => Promise<void>;
  micHint: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  stopCurrentRequest: () => Promise<void>;
  clearHistory: () => Promise<void>;
}

function formatRecognitionMeta(meta: VoiceInputContext["metadata"] | null): Array<string> {
  if (!meta) {
    return [];
  }

  return [
    meta.language ? `语言 ${meta.language}` : "",
    meta.emotion ? `情感 ${meta.emotion}` : "",
    meta.event ? `事件 ${meta.event}` : ""
  ].filter(Boolean);
}

export function ConsoleChatPane({
  busy,
  clearingHistory,
  historyLoaded,
  historyHasMore,
  loadingMoreHistory,
  messages,
  chatListRef,
  chatBottomRef,
  onChatScroll,
  pendingApproval,
  skillsCatalog,
  activatedSkills,
  approvalIndex,
  setApprovalIndex,
  submitApproval,
  draft,
  setDraft,
  inputRef,
  inputDisabled,
  onInputKeyDown,
  toggleMicRecording,
  micButtonDisabled,
  recording,
  transcribing,
  micButtonLabel,
  stoppingRequest,
  voiceSession,
  pendingVoiceContext,
  toggleVoiceSession,
  micHint,
  onSubmit,
  stopCurrentRequest,
  clearHistory
}: ConsoleChatPaneProps) {
  const recognitionLabels = formatRecognitionMeta(
    voiceSession?.userTranscriptMetadata ?? pendingVoiceContext?.metadata ?? null
  );

  useLayoutEffect(() => {
    const node = inputRef.current;
    if (!node) {
      return;
    }

    const maxHeight = 176;
    node.style.height = "0px";
    const nextHeight = Math.min(node.scrollHeight, maxHeight);
    node.style.height = `${Math.max(44, nextHeight)}px`;
    node.style.overflowY = node.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [draft, inputRef]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/70 pb-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge className="status-badge status-badge--neutral">
              语音 {voiceSession?.phase ?? "idle"}
            </Badge>
            {recognitionLabels.map((label) => (
              <Badge key={label} className="status-badge status-badge--info">
                {label}
              </Badge>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => void toggleVoiceSession()}
          >
            {voiceSession?.sessionId ? "停止实时语音" : "启动实时语音"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void clearHistory()}
            disabled={busy || clearingHistory || !historyLoaded}
            className="theme-danger-button"
          >
            {clearingHistory ? "清空中..." : "清空历史记录"}
          </Button>
        </div>
      </div>
      <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
        {skillsCatalog ? (
          <div className="status-surface status-surface--info rounded-xl px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="status-badge status-badge--info">Skills</Badge>
              <span>已启用 {skillsCatalog.enabledCount} 个</span>
              {skillsCatalog.truncated ? (
                <Badge className="status-badge status-badge--warn">Catalog 已截断</Badge>
              ) : null}
            </div>
            {skillsCatalog.truncated ? (
              <p className="mt-2 text-xs opacity-85">
                已裁剪 {skillsCatalog.truncatedDescriptions} 条描述，省略 {skillsCatalog.omittedSkills} 个 skill。
              </p>
            ) : null}
            {activatedSkills.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {activatedSkills.map((skill) => (
                  <Badge key={skill.skillId} className="status-badge status-badge--neutral">
                    {skill.name} · {skill.compatibility.status}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <div
          ref={chatListRef}
          className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-2"
          onScroll={onChatScroll}
        >
          {historyLoaded && historyHasMore ? (
            <div className="flex justify-center">
              <span className="surface-panel rounded-full px-3 py-1 text-xs text-muted-foreground">
                {loadingMoreHistory ? "正在加载更早消息..." : "上滑到顶部自动加载历史消息"}
              </span>
            </div>
          ) : null}

          {!historyLoaded ? (
            <p className="surface-dashed px-3 py-4 text-sm text-muted-foreground">
              正在加载历史消息...
            </p>
          ) : messages.length === 0 ? (
            <p className="surface-dashed px-3 py-4 text-sm text-muted-foreground">
              暂无对话记录，发一条消息开始聊天吧。
            </p>
          ) : (
            messages.map((item) => (
              <div
                key={item.id}
                className={
                  item.role === "user"
                    ? "ml-auto flex max-w-[80%] flex-col items-end"
                    : "mr-auto flex max-w-[88%] flex-col items-start"
                }
              >
                {item.role === "assistant" ? <AssistantProcessView message={item} /> : null}
                {item.role === "user" ? (
                  <div className="w-fit rounded-2xl bg-primary px-4 py-3 text-sm text-primary-foreground">
                    <p className="whitespace-pre-wrap leading-relaxed">{item.text || "..."}</p>
                  </div>
                ) : item.text.trim() || item.source === "yobi" ? (
                  <div
                    className={`w-fit rounded-2xl border px-4 py-3 text-sm ${
                      item.state === "error"
                        ? "status-surface status-surface--danger"
                        : "status-surface status-surface--neutral"
                    }`}
                  >
                    {item.source === "yobi" ? (
                      <div className="mb-2 flex items-center gap-2">
                        <Badge className="status-badge status-badge--info">Yobi</Badge>
                        <span className="text-[11px] text-muted-foreground">后台主动消息</span>
                      </div>
                    ) : null}
                    {item.text.trim() ? <MarkdownContent variant="chat" markdown={item.text} /> : null}
                  </div>
                ) : null}
              </div>
            ))
          )}
          <div ref={chatBottomRef} />
        </div>

        <div className="relative border-t border-border/70 px-1 pb-1 pt-4">
          {pendingApproval ? (
            <div className="status-surface status-surface--warn absolute bottom-full left-0 right-0 mb-2 rounded-xl p-3 shadow-lg">
              <p className="text-sm font-medium">需要确认命令：{pendingApproval.toolName}</p>
              <p className="mt-1 whitespace-pre-wrap text-xs opacity-90">
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
                    className={`approval-option ${approvalIndex === index ? "approval-option--active" : ""}`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <form onSubmit={onSubmit} className="flex items-end gap-2">
            <Textarea
              ref={inputRef}
              rows={1}
              value={draft}
              placeholder="和 Yobi 说点什么"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onInputKeyDown}
              disabled={inputDisabled}
              className="max-h-44 min-h-[44px] flex-1 resize-none rounded-xl border-border/80 bg-card/95 px-4 py-3 text-[15px] leading-6 shadow-sm"
            />
            <Button
              type="button"
              variant="outline"
              onClick={toggleMicRecording}
              disabled={micButtonDisabled}
              className={`h-11 min-w-[88px] shrink-0 whitespace-nowrap ${
                recording ? "theme-recording-button" : ""
              }`}
              title={micHint || "单击开始录音，再次单击结束识别"}
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
            {busy ? (
              <Button
                type="button"
                onClick={() => void stopCurrentRequest()}
                disabled={stoppingRequest}
                className="h-11 w-11 min-w-0 shrink-0 rounded-full bg-foreground p-0 text-background hover:bg-foreground/90"
                title="停止生成"
                aria-label="停止生成"
              >
                {stoppingRequest ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Square className="h-4 w-4 fill-current" />
                )}
              </Button>
            ) : (
              <Button
                type="submit"
                disabled={recording || transcribing || draft.trim().length === 0}
                className="h-11 min-w-[92px] shrink-0 whitespace-nowrap"
              >
                发送
              </Button>
            )}
          </form>
          {micHint ? (
            <p className="mt-2 text-xs text-muted-foreground">{micHint}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
