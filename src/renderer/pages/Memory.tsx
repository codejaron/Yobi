import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_RELATIONSHIP_GUIDE,
  RELATIONSHIP_STAGES,
  type MindSnapshot,
  type RelationshipGuide
} from "@shared/types";
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
  onSaveRelationship,
  onTriggerKernelTask,
  onResetMindSection
}: {
  snapshot: MindSnapshot | null;
  onRefresh: () => Promise<void>;
  onSaveSoul: (markdown: string) => Promise<void>;
  onSaveRelationship: (guide: RelationshipGuide) => Promise<void>;
  onTriggerKernelTask: (taskType: "tick-now" | "daily-now") => Promise<{ accepted: boolean; message: string }>;
  onResetMindSection: (input: {
    section: "soul" | "relationship" | "state" | "profile" | "facts" | "episodes";
  }) => Promise<{ accepted: boolean; message: string }>;
}) {
  const [soulDraft, setSoulDraft] = useState(snapshot?.soul ?? "");
  const [relationshipDraft, setRelationshipDraft] = useState<RelationshipGuide>(
    cloneRelationshipGuide(snapshot?.relationship ?? DEFAULT_RELATIONSHIP_GUIDE)
  );
  const [saving, setSaving] = useState<"soul" | "relationship" | null>(null);
  const [resetting, setResetting] = useState<
    "soul" | "relationship" | "state" | "profile" | "facts" | "episodes" | null
  >(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setSoulDraft(snapshot?.soul ?? "");
  }, [snapshot?.soul]);

  useEffect(() => {
    const nextGuide = cloneRelationshipGuide(snapshot?.relationship ?? DEFAULT_RELATIONSHIP_GUIDE);
    setRelationshipDraft(nextGuide);
  }, [snapshot?.relationship]);

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

  const resetSection = async (
    section: "soul" | "relationship" | "state" | "profile" | "facts" | "episodes",
    label: string
  ) => {
    const ok = window.confirm(`确认${label}吗？`);
    if (!ok) {
      return;
    }
    setResetting(section);
    try {
      const result = await onResetMindSection({
        section
      });
      setNotice(result.message);
      await onRefresh();
    } finally {
      setResetting(null);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Mind Center</CardTitle>
          <CardDescription>
            编辑 SOUL / RELATIONSHIP，查看 STATE / PROFILE / FACTS / EPISODES 快照。
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

      <Card>
        <CardHeader>
          <CardTitle>SOUL (可编辑)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Textarea rows={18} value={soulDraft} onChange={(event) => setSoulDraft(event.target.value)} />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={saving !== null || resetting !== null}
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
            <Button
              variant="outline"
              disabled={saving !== null || resetting !== null}
              onClick={() => void resetSection("soul", "恢复 SOUL 默认内容")}
            >
              {resetting === "soul" ? "处理中..." : "恢复默认"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>RELATIONSHIP (可编辑)</CardTitle>
          <CardDescription>只保留 5 个阶段规则。每行一条，当前阶段会单独传给模型。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            {RELATIONSHIP_STAGES.map((stage) => (
              <div key={stage} className="space-y-1.5">
                <Label>{stage}</Label>
                <Textarea
                  rows={5}
                  value={relationshipDraft.stages[stage].join("\n")}
                  onChange={(event) =>
                    setRelationshipDraft((current) => ({
                      ...current,
                      stages: {
                        ...current.stages,
                        [stage]: parseRuleLines(event.target.value)
                      }
                    }))
                  }
                />
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={saving !== null || resetting !== null}
              onClick={async () => {
                setSaving("relationship");
                try {
                  await onSaveRelationship(relationshipDraft);
                  setNotice("RELATIONSHIP 已保存");
                  await onRefresh();
                } finally {
                  setSaving(null);
                }
              }}
            >
              {saving === "relationship" ? "保存中..." : "保存 RELATIONSHIP"}
            </Button>
            <Button
              variant="outline"
              disabled={saving !== null || resetting !== null}
              onClick={() => void resetSection("relationship", "恢复 RELATIONSHIP 默认内容")}
            >
              {resetting === "relationship" ? "处理中..." : "恢复默认"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>STATE (只读)</CardTitle>
          <CardDescription>实时情绪与关系状态。</CardDescription>
          <Button
            size="sm"
            variant="outline"
            disabled={saving !== null || resetting !== null}
            onClick={() => void resetSection("state", "重置 STATE")}
          >
            {resetting === "state" ? "处理中..." : "重置"}
          </Button>
        </CardHeader>
        <CardContent>
          <ReadonlyJson value={stateJson} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>PROFILE (只读)</CardTitle>
          <CardDescription>用户画像与确认中推断。</CardDescription>
          <Button
            size="sm"
            variant="outline"
            disabled={saving !== null || resetting !== null}
            onClick={() => void resetSection("profile", "重置 PROFILE")}
          >
            {resetting === "profile" ? "处理中..." : "重置"}
          </Button>
        </CardHeader>
        <CardContent>
          <ReadonlyJson value={profileJson} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>FACTS (只读)</CardTitle>
          <CardDescription>最近结构化事实。</CardDescription>
          <Button
            size="sm"
            variant="outline"
            disabled={saving !== null || resetting !== null}
            onClick={() => void resetSection("facts", "清空 FACTS 与归档")}
          >
            {resetting === "facts" ? "处理中..." : "清空"}
          </Button>
        </CardHeader>
        <CardContent>
          <ReadonlyJson value={factsJson} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>EPISODES (只读)</CardTitle>
          <CardDescription>最近情景记忆。</CardDescription>
          <Button
            size="sm"
            variant="outline"
            disabled={saving !== null || resetting !== null}
            onClick={() => void resetSection("episodes", "清空 EPISODES")}
          >
            {resetting === "episodes" ? "处理中..." : "清空"}
          </Button>
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

function parseRuleLines(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function cloneRelationshipGuide(input: RelationshipGuide): RelationshipGuide {
  return {
    stages: {
      stranger: [...input.stages.stranger],
      acquaintance: [...input.stages.acquaintance],
      familiar: [...input.stages.familiar],
      close: [...input.stages.close],
      intimate: [...input.stages.intimate]
    }
  };
}
