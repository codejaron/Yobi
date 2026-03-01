import type { FormEvent, RefObject } from "react";
import { Loader2, Send } from "lucide-react";
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
import { chatItemClassName } from "./useClawTabController";
import type { ClawChatItem, ConnectionBadge } from "./types";

interface ClawChatPaneProps {
  connectionBadge: ConnectionBadge;
  connectionMessage: string;
  chatItems: ClawChatItem[];
  chatBottomRef: RefObject<HTMLDivElement | null>;
  draft: string;
  sending: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}

export function ClawChatPane({
  connectionBadge,
  connectionMessage,
  chatItems,
  chatBottomRef,
  draft,
  sending,
  onDraftChange,
  onSubmit
}: ClawChatPaneProps) {
  return (
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

        <form onSubmit={onSubmit} className="flex gap-2 border-t border-border/70 pt-4">
          <Input
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
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
  );
}
