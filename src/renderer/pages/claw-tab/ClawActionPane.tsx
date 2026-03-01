import type { RefObject } from "react";
import { Square, Trash2 } from "lucide-react";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@renderer/components/ui/card";
import { Switch } from "@renderer/components/ui/switch";
import { singleLine } from "@renderer/pages/chat-utils";
import { actionItemClassName } from "./useClawTabController";
import type { ClawActionItem } from "./types";

interface ClawActionPaneProps {
  logEnabled: boolean;
  setLogEnabled: (enabled: boolean) => void;
  clearActionLogs: () => void;
  actionItems: ClawActionItem[];
  expandedActions: Record<string, boolean>;
  toggleActionExpanded: (id: string) => void;
  loadingHistory: boolean;
  historyError: string;
  onAbort: () => Promise<void>;
  actionBottomRef: RefObject<HTMLDivElement | null>;
}

export function ClawActionPane({
  logEnabled,
  setLogEnabled,
  clearActionLogs,
  actionItems,
  expandedActions,
  toggleActionExpanded,
  loadingHistory,
  historyError,
  onAbort,
  actionBottomRef
}: ClawActionPaneProps) {
  return (
    <Card className="flex h-full min-h-0 flex-col overflow-hidden">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>执行日志</CardTitle>
          <CardDescription>
            {logEnabled ? "过程消息默认折叠；仅保留任务中止控制。" : "日志采集已关闭（可随时恢复）。"}
          </CardDescription>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="whitespace-nowrap text-xs text-muted-foreground">记录</span>
          <Switch
            checked={logEnabled}
            onChange={setLogEnabled}
            aria-label="启用 Claw 执行日志采集"
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0 text-muted-foreground hover:text-rose-600"
            onClick={clearActionLogs}
            disabled={actionItems.length === 0}
            aria-label="清空 Claw 执行日志"
            title="清空 Claw 执行日志"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
        <Button
          type="button"
          variant="outline"
          onClick={() => void onAbort()}
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
          {!logEnabled ? (
            <p className="rounded-lg border border-dashed border-border/70 bg-white/55 px-3 py-3 text-xs text-muted-foreground">
              日志采集已关闭（可随时恢复）。
            </p>
          ) : actionItems.length === 0 ? (
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
                  onClick={() => toggleActionExpanded(item.id)}
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
  );
}
