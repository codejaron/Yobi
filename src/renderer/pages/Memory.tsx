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

  useEffect(() => {
    setDraft(document?.markdown ?? "");
  }, [document?.markdown]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Working Memory</CardTitle>
          <CardDescription>
            这里展示并编辑当前工作记忆。内容会直接影响后续对话风格与上下文引用。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label>Markdown 内容</Label>
            <Textarea
              rows={20}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
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
