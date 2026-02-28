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
      <CardHeader>
        <CardTitle>角色人设编辑器</CardTitle>
        <CardDescription>
          这里的 System Prompt 会注入到每次聊天和主动决策流程。
        </CardDescription>
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
          <Label>System Prompt</Label>
          <Textarea
            className="min-h-[280px]"
            value={draft.systemPrompt}
            onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })}
          />
        </div>

        <div className="space-y-1.5">
          <Label>Working Memory Template</Label>
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
