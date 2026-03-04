import { useEffect, useMemo, useState } from "react";
import type { MindSnapshot } from "@shared/types";
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
  snapshot,
  onRefresh,
  onSaveSoul,
  onSavePersona,
  onTriggerKernelTask
}: {
  snapshot: MindSnapshot | null;
  onRefresh: () => Promise<void>;
  onSaveSoul: (markdown: string) => Promise<void>;
  onSavePersona: (markdown: string) => Promise<void>;
  onTriggerKernelTask: (taskType: "tick-now" | "daily-now") => Promise<{ accepted: boolean; message: string }>;
}) {
  const [soulDraft, setSoulDraft] = useState(snapshot?.soul ?? "");
  const [personaDraft, setPersonaDraft] = useState(snapshot?.persona ?? "");
  const [saving, setSaving] = useState<"soul" | "persona" | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setSoulDraft(snapshot?.soul ?? "");
    setPersonaDraft(snapshot?.persona ?? "");
  }, [snapshot?.soul, snapshot?.persona]);

  const stateJson = useMemo(
    () => (snapshot ? JSON.stringify(snapshot.state, null, 2) : "{}"),
    [snapshot]
  );
  const profileJson = useMemo(
    () => (snapshot ? JSON.stringify(snapshot.profile, null, 2) : "{}"),
    [snapshot]
  );
  const factsJson = useMemo(
    () => (snapshot ? JSON.stringify(snapshot.recentFacts, null, 2) : "[]"),
    [snapshot]
  );
  const episodesJson = useMemo(
    () => (snapshot ? JSON.stringify(snapshot.recentEpisodes, null, 2) : "[]"),
    [snapshot]
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Mind Center</CardTitle>
          <CardDescription>
            编辑 SOUL / PERSONA，查看 STATE / PROFILE / FACTS / EPISODES 快照。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={async () => {
                setNotice("");
                const result = await onTriggerKernelTask("tick-now");
                setNotice(result.message);
                await onRefresh();
              }}
              variant="outline"
            >
              触发一次内核 Tick
            </Button>
            <Button
              onClick={async () => {
                setNotice("");
                const result = await onTriggerKernelTask("daily-now");
                setNotice(result.message);
                await onRefresh();
              }}
              variant="outline"
            >
              触发每日任务
            </Button>
            <Button
              onClick={() => {
                void onRefresh().then(() => setNotice("已刷新 Mind 快照"));
              }}
            >
              刷新快照
            </Button>
          </div>
          {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>SOUL (可编辑)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Textarea rows={16} value={soulDraft} onChange={(event) => setSoulDraft(event.target.value)} />
            <Button
              disabled={saving !== null}
              onClick={async () => {
                setSaving("soul");
                try {
                  await onSaveSoul(soulDraft);
                  setNotice("SOUL 已保存");
                  await onRefresh();
                } finally {
                  setSaving(null);
                }
              }}
            >
              {saving === "soul" ? "保存中..." : "保存 SOUL"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>PERSONA (可编辑)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Textarea
              rows={16}
              value={personaDraft}
              onChange={(event) => setPersonaDraft(event.target.value)}
            />
            <Button
              disabled={saving !== null}
              onClick={async () => {
                setSaving("persona");
                try {
                  await onSavePersona(personaDraft);
                  setNotice("PERSONA 已保存");
                  await onRefresh();
                } finally {
                  setSaving(null);
                }
              }}
            >
              {saving === "persona" ? "保存中..." : "保存 PERSONA"}
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>STATE (只读)</CardTitle>
          <CardDescription>实时情绪与关系状态。</CardDescription>
        </CardHeader>
        <CardContent>
          <ReadonlyJson value={stateJson} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>PROFILE (只读)</CardTitle>
          <CardDescription>用户画像与确认中推断。</CardDescription>
        </CardHeader>
        <CardContent>
          <ReadonlyJson value={profileJson} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>FACTS (只读)</CardTitle>
          <CardDescription>最近结构化事实。</CardDescription>
        </CardHeader>
        <CardContent>
          <ReadonlyJson value={factsJson} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>EPISODES (只读)</CardTitle>
          <CardDescription>最近情景记忆。</CardDescription>
        </CardHeader>
        <CardContent>
          <ReadonlyJson value={episodesJson} />
        </CardContent>
      </Card>
    </div>
  );
}

function ReadonlyJson({ value }: { value: string }) {
  return (
    <div className="space-y-1.5">
      <Label>JSON</Label>
      <Textarea value={value} rows={16} readOnly className="font-mono text-xs" />
    </div>
  );
}
