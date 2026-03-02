import { useEffect, useState } from "react";
import type { CharacterProfile } from "@shared/types";
import { Button } from "@renderer/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@renderer/components/ui/card";
import { MarkdownContent } from "@renderer/components/chat/MarkdownContent";
import { Input } from "@renderer/components/ui/input";
import { Label } from "@renderer/components/ui/label";
import { Textarea } from "@renderer/components/ui/textarea";

export function CharacterPage({
  profile,
  onSave
}: {
  profile: CharacterProfile | null;
  onSave: (profile: CharacterProfile) => Promise<void>;
}) {
  const [draft, setDraft] = useState<CharacterProfile | null>(profile);
  const [saving, setSaving] = useState(false);
  const [viewMode, setViewMode] = useState<"preview" | "edit">("preview");

  useEffect(() => {
    setDraft(profile);
  }, [profile]);

  if (!draft) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>角色加载中</CardTitle>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle>角色人设编辑器</CardTitle>
            <CardDescription>
              这里的 System Prompt 会注入到每次聊天和主动决策流程。
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
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label>角色 ID</Label>
            <Input
              value={draft.id}
              onChange={(event) => setDraft({ ...draft, id: event.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>角色名称</Label>
            <Input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label>{viewMode === "preview" ? "System Prompt 预览" : "System Prompt"}</Label>
            <span className="text-xs text-muted-foreground">
              {viewMode === "preview" ? "正文与编辑态字号一致" : "切换到预览查看渲染结果"}
            </span>
          </div>
          {viewMode === "edit" ? (
            <Textarea
              className="min-h-[280px]"
              value={draft.systemPrompt}
              onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })}
            />
          ) : (
            <div className="min-h-[280px] rounded-xl border border-border/70 bg-white/80 px-4 py-4">
              {draft.systemPrompt.trim().length > 0 ? (
                <MarkdownContent variant="memory" markdown={draft.systemPrompt} />
              ) : (
                <p className="text-sm text-muted-foreground">暂无内容，切换到编辑模式开始编写。</p>
              )}
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label>{viewMode === "preview" ? "Working Memory Template 预览" : "Working Memory Template"}</Label>
            <span className="text-xs text-muted-foreground">
              {viewMode === "preview" ? "正文与编辑态字号一致" : "支持 Markdown 编辑"}
            </span>
          </div>
          {viewMode === "edit" ? (
            <Textarea
              className="min-h-[220px]"
              value={draft.workingMemoryTemplate ?? ""}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  workingMemoryTemplate: event.target.value
                })
              }
            />
          ) : (
            <div className="min-h-[220px] rounded-xl border border-border/70 bg-white/80 px-4 py-4">
              {(draft.workingMemoryTemplate ?? "").trim().length > 0 ? (
                <MarkdownContent variant="memory" markdown={draft.workingMemoryTemplate ?? ""} />
              ) : (
                <p className="text-sm text-muted-foreground">暂无内容，切换到编辑模式开始编写。</p>
              )}
            </div>
          )}
        </div>

        <Button
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave(draft);
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "保存中..." : "保存角色"}
        </Button>
      </CardContent>
    </Card>
  );
}
