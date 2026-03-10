import { useEffect, useState } from "react";
import { MessageCircle, Trash2 } from "lucide-react";
import type { AppStatus, TopicPoolItem } from "@shared/types";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@renderer/components/ui/card";

function formatDateTime(value: string | null): string {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString();
}

function formatTopicSource(value: string): string {
  if (value === "recall") {
    return "回想";
  }

  if (value === "wander") {
    return "浏览";
  }

  if (value === "browse:event") {
    return "B站事件";
  }

  if (value === "browse:digest") {
    return "B站摘要";
  }

  if (value === "browse:reverse") {
    return "反向提问";
  }

  return value || "未知来源";
}

function formatTopicTimeliness(value: string | null): string {
  if (!value) {
    return "长期";
  }

  const remainingMs = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(remainingMs)) {
    return "时效未知";
  }

  if (remainingMs <= 0) {
    return "已过期";
  }

  const minutes = Math.ceil(remainingMs / 60000);
  if (minutes < 60) {
    return `${minutes} 分钟内`;
  }

  const hours = Math.ceil(minutes / 60);
  if (hours < 48) {
    return `${hours} 小时内`;
  }

  const days = Math.ceil(hours / 24);
  return `${days} 天内`;
}

function topicSort(a: TopicPoolItem, b: TopicPoolItem): number {
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

export function TopicPoolPage({
  status,
  refreshStatus
}: {
  status: AppStatus | null;
  refreshStatus: () => Promise<void>;
}) {
  const [triggering, setTriggering] = useState<"recall" | null>(null);
  const [taskNotice, setTaskNotice] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [topicAction, setTopicAction] = useState<
    | {
        kind: "delete";
        topicId: string;
      }
    | {
        kind: "clear";
      }
    | null
  >(null);
  const items = [...(status?.topicPool ?? [])].sort(topicSort);
  const pendingCount = items.filter((item) => !item.used).length;
  const usedCount = items.length - pendingCount;
  const deletingTopicId = topicAction?.kind === "delete" ? topicAction.topicId : null;
  const clearingAllTopics = topicAction?.kind === "clear";
  const topicActionBusy = topicAction !== null;

  useEffect(() => {
    if (!taskNotice) {
      return;
    }

    const timer = setTimeout(() => {
      setTaskNotice(null);
    }, 3000);

    return () => {
      clearTimeout(timer);
    };
  }, [taskNotice]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">手动触发</CardTitle>
          <CardDescription>可立即执行回想/浏览，不受定时等待影响。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => {
                if (triggering) {
                  return;
                }

                setTaskNotice(null);
                setTriggering("recall");
                void window.companion
                  .triggerTopicRecall()
                  .then(async (result) => {
                    setTaskNotice({
                      type: result.accepted ? "success" : "error",
                      message: result.message
                    });
                    await refreshStatus();
                  })
                  .catch((error) => {
                    setTaskNotice({
                      type: "error",
                      message: error instanceof Error ? error.message : "触发回想失败。"
                    });
                  })
                  .finally(() => {
                    setTriggering(null);
                  });
              }}
              disabled={triggering !== null}
            >
              {triggering === "recall" ? "回想触发中..." : "立即触发回想"}
            </Button>

          </div>
          {taskNotice ? (
            <p className={`text-xs ${taskNotice.type === "success" ? "text-emerald-700" : "text-rose-700"}`}>
              {taskNotice.message}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>待触发</CardDescription>
            <CardTitle className="text-2xl">{pendingCount} 条</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>已使用（3 天内）</CardDescription>
            <CardTitle className="text-2xl">{usedCount} 条</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>容量</CardDescription>
            <CardTitle className="text-2xl">{pendingCount}/10</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardDescription>话题池列表</CardDescription>
              <CardTitle className="flex items-center gap-2 text-base">
                <MessageCircle className="h-4 w-4" />
                当前话题（含已使用）
              </CardTitle>
            </div>

            <Button
              variant="outline"
              size="sm"
              className="border-rose-200 text-rose-700 hover:bg-rose-50"
              disabled={topicActionBusy || items.length === 0}
              onClick={() => {
                if (topicActionBusy || items.length === 0) {
                  return;
                }

                const confirmed = window.confirm(`确认清空全部 ${items.length} 条话题吗？此操作不可撤销。`);
                if (!confirmed) {
                  return;
                }

                setTaskNotice(null);
                setTopicAction({
                  kind: "clear"
                });
                void window.companion
                  .clearTopicPool()
                  .then(async (result) => {
                    setTaskNotice({
                      type: result.accepted ? "success" : "error",
                      message: result.message
                    });
                    await refreshStatus();
                  })
                  .catch((error) => {
                    setTaskNotice({
                      type: "error",
                      message: error instanceof Error ? error.message : "清空话题池失败。"
                    });
                  })
                  .finally(() => {
                    setTopicAction(null);
                  });
              }}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {clearingAllTopics ? "清空中..." : "清空全部"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {items.length > 0 ? (
            items.map((topic) => (
              <div
                key={topic.id}
                className="rounded-md border border-border/70 bg-white/70 px-3 py-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className={`text-sm ${topic.used ? "text-muted-foreground line-through" : ""}`}>
                    {topic.text}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-rose-700 hover:bg-rose-50"
                    disabled={topicActionBusy}
                    onClick={() => {
                      if (topicActionBusy) {
                        return;
                      }

                      const confirmed = window.confirm("确认删除这条话题吗？");
                      if (!confirmed) {
                        return;
                      }

                      setTaskNotice(null);
                      setTopicAction({
                        kind: "delete",
                        topicId: topic.id
                      });
                      void window.companion
                        .deleteTopicPoolItem(topic.id)
                        .then(async (result) => {
                          setTaskNotice({
                            type: result.accepted ? "success" : "error",
                            message: result.message
                          });
                          await refreshStatus();
                        })
                        .catch((error) => {
                          setTaskNotice({
                            type: "error",
                            message: error instanceof Error ? error.message : "删除话题失败。"
                          });
                        })
                        .finally(() => {
                          setTopicAction(null);
                        });
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span className="sr-only">删除话题</span>
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge className="border-slate-300 bg-white/70">{formatTopicSource(topic.source)}</Badge>
                  <Badge
                    className={
                      topic.expiresAt
                        ? "border-amber-300 bg-amber-50/70 text-amber-700"
                        : "border-slate-300 bg-white/70"
                    }
                  >
                    {formatTopicTimeliness(topic.expiresAt)}
                  </Badge>
                  <Badge
                    className={
                      topic.used
                        ? "border-slate-300 bg-slate-100/70 text-slate-600"
                        : "border-emerald-300 bg-emerald-50/70 text-emerald-700"
                    }
                  >
                    {topic.used ? "已使用" : "待触发"}
                  </Badge>
                  <span>入池时间 {formatDateTime(topic.createdAt)}</span>
                  {deletingTopicId === topic.id ? <span className="text-rose-700">删除中...</span> : null}
                </div>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">当前没有可展示的话题。</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
