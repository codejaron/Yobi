import { useCallback, useEffect, useMemo, useState } from "react";
import type { MemoryFact } from "@shared/types";
import { Button } from "@renderer/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@renderer/components/ui/card";
import { Input } from "@renderer/components/ui/input";
import { Label } from "@renderer/components/ui/label";

export function MemoryPage({
  facts,
  onUpsert,
  onDelete,
  onClearAll,
  onOpenFileLocation
}: {
  facts: MemoryFact[];
  onUpsert: (input: { id?: string; content: string; confidence: number }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClearAll: () => Promise<void>;
  onOpenFileLocation: () => Promise<void>;
}) {
  const PAGE_SIZE = 5;
  const [content, setContent] = useState("");
  const [confidence, setConfidence] = useState("0.7");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);
  const [clearingAll, setClearingAll] = useState(false);

  const sortedFacts = useMemo(
    () => [...facts].sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1)),
    [facts]
  );
  const visibleFacts = useMemo(() => sortedFacts.slice(0, visibleCount), [sortedFacts, visibleCount]);
  const hasMore = visibleCount < sortedFacts.length;

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    setLoadingMore(false);
  }, [facts.length]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) {
      return;
    }

    setLoadingMore(true);
    requestAnimationFrame(() => {
      setVisibleCount((current) => Math.min(sortedFacts.length, current + PAGE_SIZE));
      setLoadingMore(false);
    });
  }, [hasMore, loadingMore, sortedFacts.length]);

  const handleListScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (loadingMore || !hasMore) {
        return;
      }

      const element = event.currentTarget;
      const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 36;
      if (nearBottom) {
        loadMore();
      }
    },
    [hasMore, loadMore, loadingMore]
  );

  const handleClearAll = useCallback(async () => {
    if (clearingAll || sortedFacts.length === 0) {
      return;
    }

    const confirmed = window.confirm("确认一键清空全部长期记忆吗？该操作不可撤销。");
    if (!confirmed) {
      return;
    }

    setClearingAll(true);
    try {
      await onClearAll();
    } finally {
      setClearingAll(false);
    }
  }, [clearingAll, onClearAll, sortedFacts.length]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>新增长期记忆</CardTitle>
          <CardDescription>写入对长期陪伴有价值、相对稳定的用户事实。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label>事实</Label>
            <Input
              value={content}
              placeholder="例如: 用户每天早上 7 点会晨跑"
              onChange={(event) => setContent(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>置信度（0 - 1）</Label>
            <Input
              value={confidence}
              onChange={(event) => setConfidence(event.target.value)}
            />
          </div>
          <Button
            onClick={async () => {
              if (!content.trim()) {
                return;
              }

              await onUpsert({
                content: content.trim(),
                confidence: Math.max(0, Math.min(1, Number(confidence) || 0.5))
              });
              setContent("");
              setConfidence("0.7");
            }}
          >
            添加记忆
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle>记忆库</CardTitle>
            <CardDescription>共 {sortedFacts.length} 条，按更新时间倒序。</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleClearAll()}
              disabled={clearingAll || sortedFacts.length === 0}
              className="border-rose-200 text-rose-700 hover:border-rose-300 hover:bg-rose-50"
            >
              {clearingAll ? "清空中..." : "一键清空长期记忆"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void onOpenFileLocation()}>
              打开记忆文件位置
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {sortedFacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无长期记忆。</p>
          ) : (
            <div className="max-h-[560px] space-y-3 overflow-y-auto pr-1" onScroll={handleListScroll}>
              {visibleFacts.map((fact) => (
                <div
                  key={fact.id}
                  className="rounded-lg border border-border/70 bg-white/70 p-3 text-sm"
                >
                  <p>{fact.content}</p>
                  <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                    <span>置信度: {fact.confidence.toFixed(2)}</span>
                    <span>{new Date(fact.updatedAt).toLocaleString()}</span>
                  </div>
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        void onUpsert({
                          id: fact.id,
                          content: fact.content,
                          confidence: fact.confidence
                        })
                      }
                    >
                      刷新时间
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void onDelete(fact.id)}>
                      删除
                    </Button>
                  </div>
                </div>
              ))}

              {hasMore ? (
                <div className="flex justify-center">
                  <span className="rounded-full border border-border/70 bg-white/75 px-3 py-1 text-xs text-muted-foreground">
                    {loadingMore ? "正在加载更多记忆..." : "下滑到底部加载 5 条更多记忆"}
                  </span>
                </div>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
