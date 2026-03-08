import type { FormEvent, KeyboardEvent, RefObject, UIEvent } from "react";
import type { CommandApprovalDecision } from "@shared/types";
import { Loader2, Mic, Square } from "lucide-react";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle
} from "@renderer/components/ui/card";
import { Input } from "@renderer/components/ui/input";
import { MarkdownContent } from "@renderer/components/chat/MarkdownContent";
import { APPROVAL_OPTIONS } from "./types";
import type { ConsoleMessage, PendingApproval } from "./types";

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
  approvalIndex: number;
  setApprovalIndex: (index: number) => void;
  submitApproval: (decision: CommandApprovalDecision) => Promise<void>;
  draft: string;
  setDraft: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  inputDisabled: boolean;
  onInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  toggleMicRecording: () => void;
  micButtonDisabled: boolean;
  recording: boolean;
  transcribing: boolean;
  micButtonLabel: string;
  sttReady: boolean;
  micHint: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  clearHistory: () => Promise<void>;
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
  sttReady,
  micHint,
  onSubmit,
  clearHistory
}: ConsoleChatPaneProps) {
  return (
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
          onScroll={onChatScroll}
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
                {item.role === "assistant" && item.source === "claw" ? (
                  <div className="mb-2 flex items-center gap-2">
                    <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700">Claw</Badge>
                    <span className="text-[11px] text-muted-foreground">来自 Claw 执行结果</span>
                  </div>
                ) : item.role === "assistant" && item.source === "yobi" ? (
                  <div className="mb-2 flex items-center gap-2">
                    <Badge className="border-sky-200 bg-sky-50 text-sky-700">Yobi</Badge>
                    <span className="text-[11px] text-muted-foreground">后台主动消息</span>
                  </div>
                ) : null}
                {item.role === "assistant" ? (
                  <MarkdownContent variant="chat" markdown={item.text || "..."} />
                ) : (
                  <p className="whitespace-pre-wrap leading-relaxed">{item.text || "..."}</p>
                )}
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

          <form onSubmit={onSubmit} className="flex gap-2">
            <Input
              ref={inputRef}
              value={draft}
              placeholder="和 Yobi 说点什么"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onInputKeyDown}
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
                  : micHint || "请先在设置里启用本地 Whisper 或阿里语音"
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
  );
}
