import { useEffect, useState } from "react";
import type { WorkingMemoryDocument } from "@shared/types";
import { Button } from "@renderer/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@renderer/components/ui/card";
import { MarkdownContent } from "@renderer/components/chat/MarkdownContent";
import { Label } from "@renderer/components/ui/label";
import { Textarea } from "@renderer/components/ui/textarea";

export function MemoryPage({
  document,
  onSave,
  onRefresh
}: {
  document: WorkingMemoryDocument | null;
  onSave: (markdown: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(document?.markdown ?? "");
  const [saving, setSaving] = useState(false);
  const [viewMode, setViewMode] = useState<"preview" | "edit">("preview");

  useEffect(() => {
    setDraft(document?.markdown ?? "");
  }, [document?.markdown]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1.5">
              <CardTitle>Working Memory</CardTitle>
              <CardDescription>
                这里展示并编辑当前工作记忆。内容会直接影响后续对话风格与上下文引用。
              </CardDescription>
            </div>

            <div className="inline-flex rounded-full border border-border/70 bg-white/80 p-1">
              <button
                type="button"
                onClick={() => setViewMode("preview")}
                className={`rounded-full px-3 py-1.5 text-xs transition ${
                  viewMode === "preview"
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                预览
              </button>
              <button
                type="button"
                onClick={() => setViewMode("edit")}
                className={`rounded-full px-3 py-1.5 text-xs transition ${
                  viewMode === "edit"
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                编辑
              </button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label>{viewMode === "preview" ? "Markdown 预览" : "Markdown 内容"}</Label>
              <span className="text-xs text-muted-foreground">
                {viewMode === "preview" ? "实时预览当前草稿" : "切换到预览查看效果"}
              </span>
            </div>

            {viewMode === "edit" ? (
              <Textarea
                rows={20}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
            ) : (
              <div className="min-h-[420px] rounded-xl border border-border/70 bg-white/80 px-4 py-4">
                {draft.trim().length > 0 ? (
                  <MarkdownContent variant="memory" markdown={draft} />
                ) : (
                  <p className="text-sm text-muted-foreground">暂无内容，切换到编辑模式开始编写。</p>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              onClick={async () => {
                setSaving(true);
                try {
                  await onSave(draft);
                } finally {
                  setSaving(false);
                }
              }}
              disabled={saving}
            >
              {saving ? "保存中..." : "保存工作记忆"}
            </Button>

            <Button variant="outline" onClick={() => void onRefresh()}>
              重新读取
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            最近更新时间：
            {document?.updatedAt ? new Date(document.updatedAt).toLocaleString() : "-"}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
