import { useMemo, useState } from "react";
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
  onDelete
}: {
  facts: MemoryFact[];
  onUpsert: (input: { id?: string; content: string; confidence: number }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [content, setContent] = useState("");
  const [confidence, setConfidence] = useState("0.7");

  const sortedFacts = useMemo(
    () => [...facts].sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1)),
    [facts]
  );

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
        <CardHeader>
          <CardTitle>记忆库</CardTitle>
          <CardDescription>共 {sortedFacts.length} 条，按更新时间倒序。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {sortedFacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无长期记忆。</p>
          ) : (
            sortedFacts.map((fact) => (
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
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
