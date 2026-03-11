import type { RefObject } from "react";
import { Trash2 } from "lucide-react";
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
import { actionColor } from "./types";
import type { ActionItem } from "./types";

interface ConsoleActionPaneProps {
  logEnabled: boolean;
  setLogEnabled: (enabled: boolean) => void;
  clearActionLogs: () => void;
  actions: ActionItem[];
  isToolAction: (item: ActionItem) => boolean;
  expandedActions: Record<string, boolean>;
  toggleActionExpanded: (id: string) => void;
  actionBottomRef: RefObject<HTMLDivElement | null>;
}

export function ConsoleActionPane({
  logEnabled,
  setLogEnabled,
  clearActionLogs,
  actions,
  isToolAction,
  expandedActions,
  toggleActionExpanded,
  actionBottomRef
}: ConsoleActionPaneProps) {
  return (
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
            className="h-8 w-8 p-0 text-muted-foreground hover:text-[hsl(var(--status-danger-foreground))]"
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
            <p className="surface-dashed px-3 py-3 text-xs text-muted-foreground">
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
                    onClick={() => toggleActionExpanded(item.id)}
                    className={`w-full rounded-lg border px-3 py-2 text-left text-xs transition hover:brightness-[0.99] ${actionColor(item.kind)}`}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <Badge>{item.label}</Badge>
                      <span className="text-[11px] text-muted-foreground">{timestamp}</span>
                    </div>
                    <p className={expanded ? "whitespace-pre-wrap leading-relaxed text-foreground/90" : "truncate leading-relaxed text-foreground/90"}>
                      {expanded ? item.detail : singleLine(item.detail, 108)}
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
  );
}
