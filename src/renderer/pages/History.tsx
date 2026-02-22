import { useEffect, useState } from "react";
import type { HistoryMessage } from "@shared/types";
import { Button } from "@renderer/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@renderer/components/ui/card";
import { Input } from "@renderer/components/ui/input";

export function HistoryPage({
  items,
  onSearch
}: {
  items: HistoryMessage[];
  onSearch: (query?: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    void onSearch();
  }, [onSearch]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>对话历史</CardTitle>
        <CardDescription>永久历史使用 JSONL 追加存储，可用于回顾与记忆提炼。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input
            value={query}
            placeholder="搜索关键词..."
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button variant="outline" onClick={() => void onSearch(query)}>
            搜索
          </Button>
          <Button variant="ghost" onClick={() => {
            setQuery("");
            void onSearch();
          }}>
            清空
          </Button>
        </div>

        <div className="max-h-[560px] space-y-2 overflow-auto pr-1">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无历史记录。</p>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                className="rounded-lg border border-border/70 bg-white/75 px-3 py-2 text-sm"
              >
                <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {item.role} · {item.channel}
                  </span>
                  <span>{new Date(item.timestamp).toLocaleString()}</span>
                </div>
                <p className="whitespace-pre-wrap leading-relaxed">{item.text}</p>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
