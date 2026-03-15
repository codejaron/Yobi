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
          <StateOverview snapshot={snapshot} rawJson={stateJson} />
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
          <ProfileOverview snapshot={snapshot} />
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

function StateOverview({
  snapshot,
  rawJson
}: {
  snapshot: MindSnapshot | null;
  rawJson: string;
}) {
  if (!snapshot) {
    return <p className="text-sm text-muted-foreground">暂无 STATE 数据。</p>;
  }

  const state = snapshot.state;
  const groups = [
    {
      title: "关系",
      items: [
        stateField("关系阶段", state.relationship.stage, "当前关系阶段。"),
        stateField("升级计数", state.relationship.upgradeStreak, "关系升级连续命中次数。"),
        stateField("降级计数", state.relationship.downgradeStreak, "关系降级连续命中次数。"),
        stateField("连接感", formatNumber(state.emotional.connection), "关系亲近感，范围 0 到 1。"),
        stateField("信任", formatNumber(state.emotional.dimensions.trust), "当前互动中的信任程度，范围 0 到 1。"),
        stateField("会话热度", formatNumber(state.emotional.sessionWarmth), "这次会话内的临时熟络度，不持久化。")
      ]
    },
    {
      title: "PAD",
      items: [
        stateField("愉悦度", formatSignedNumber(state.emotional.dimensions.pleasure), "整体正负向感受，范围 -1 到 1。"),
        stateField("唤醒度", formatSignedNumber(state.emotional.dimensions.arousal), "激活程度，范围 -1 到 1。"),
        stateField("掌控感", formatSignedNumber(state.emotional.dimensions.dominance), "主导和掌控的感觉，范围 -1 到 1。"),
        stateField("好奇心", formatNumber(state.emotional.dimensions.curiosity), "探索和求知倾向，范围 0 到 1。"),
        stateField("能量", formatNumber(state.emotional.dimensions.energy), "精神和活力水平，范围 0 到 1。")
      ]
    },
    {
      title: "基础情绪",
      items: [
        stateField("快乐", formatNumber(state.emotional.ekman.happiness), "Ekman 六基础情绪之一，范围 0 到 1。"),
        stateField("悲伤", formatNumber(state.emotional.ekman.sadness), "Ekman 六基础情绪之一，范围 0 到 1。"),
        stateField("愤怒", formatNumber(state.emotional.ekman.anger), "Ekman 六基础情绪之一，范围 0 到 1。"),
        stateField("恐惧", formatNumber(state.emotional.ekman.fear), "Ekman 六基础情绪之一，范围 0 到 1。"),
        stateField("厌恶", formatNumber(state.emotional.ekman.disgust), "Ekman 六基础情绪之一，范围 0 到 1。"),
        stateField("惊讶", formatNumber(state.emotional.ekman.surprise), "Ekman 六基础情绪之一，范围 0 到 1。")
      ]
    },
    {
      title: "运行时",
      items: [
        stateField("人格", formatPersonality(state.personality), "OCEAN 五维人格参数。"),
        stateField("反刍数量", state.ruminationQueue.length, "仍在持续影响状态的反刍条目数。"),
        stateField(
          "反刍标签",
          state.ruminationQueue.length > 0 ? state.ruminationQueue.map((entry) => entry.label).join(", ") : "无",
          "当前反刍队列里的主要标签。"
        ),
        stateField("上次衰减", formatLocalDateTime(state.lastDecayAt), "上次应用情绪衰减的时间。"),
        stateField("会话重入", state.sessionReentry ? `${state.sessionReentry.gapHours} 小时` : "否", "距离上次用户消息较久时会进入会话重入状态。"),
        stateField("更新时间", formatLocalDateTime(state.updatedAt), "STATE 最近一次写入时间。")
      ]
    }
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        {groups.map((group) => (
          <FieldGroup key={group.title} title={group.title} items={group.items} />
        ))}
      </div>
      <details className="rounded-md border border-border/60 bg-muted/20 p-3">
        <summary className="cursor-pointer text-sm font-medium text-muted-foreground">查看原始 STATE JSON</summary>
        <div className="mt-3">
          <ReadonlyJson value={rawJson} />
        </div>
      </details>
    </div>
  );
}

function ProfileOverview({ snapshot }: { snapshot: MindSnapshot | null }) {
  if (!snapshot) {
    return <p className="text-sm text-muted-foreground">暂无 PROFILE 数据。</p>;
  }

  const profile = snapshot.profile;
  const groups = [
    {
      title: "身份与习惯",
      items: [
        stateField("时区", profile.identity.timezone ?? "未设置", "用户当前使用的时区。"),
        stateField("常见作息", profile.identity.typical_schedule ?? "未设置", "用户常见的作息时间描述。"),
        stateField("语言偏好", profile.identity.language_preference, "用户的语言偏好。"),
        stateField("活跃时段", profile.patterns.active_hours ?? "未设置", "系统推断出的高频活跃时间。"),
        stateField("聊天频率", profile.patterns.chat_frequency ?? "未设置", "用户整体聊天频率描述。"),
        stateField("会话风格", profile.patterns.session_style ?? "未设置", "用户在会话中的常见互动方式。")
      ]
    },
    {
      title: "沟通偏好",
      items: [
        stateField("消息长度偏好", profile.communication.avg_message_length, "用户常见消息长度。"),
        stateField("Emoji 使用", profile.communication.emoji_usage, "用户使用 emoji 的频率。"),
        stateField("幽默接受度", formatNumber(profile.communication.humor_receptivity), "对玩笑和轻松表达的接受程度。"),
        stateField("建议接受度", formatNumber(profile.communication.advice_receptivity), "对直接建议式回复的接受程度。"),
        stateField("情感开放度", formatNumber(profile.communication.emotional_openness), "分享个人情绪和感受的开放程度。"),
        stateField("安慰偏好", profile.communication.preferred_comfort_style ?? "未设置", "偏好的情绪支持方式。")
      ]
    },
    {
      title: "已记录内容",
      items: [
        stateField("口头禅", formatList(profile.communication.catchphrases), "用户高频使用的表达。"),
        stateField("语气词", formatList(profile.communication.tone_words), "常见语气和说话风格词。"),
        stateField("话题偏好", formatList(profile.patterns.topic_preferences), "用户更常聊或更感兴趣的话题。"),
        stateField("有效方式", formatList(profile.interaction_notes.what_works), "对用户更有效的回应方式。"),
        stateField("无效方式", formatList(profile.interaction_notes.what_fails), "对用户效果较差的回应方式。"),
        stateField("敏感话题", formatList(profile.interaction_notes.sensitive_topics), "需要谨慎触及的话题。")
      ]
    },
    {
      title: "信任领域",
      items: [
        stateField("技术信任", formatNumber(profile.interaction_notes.trust_areas.tech), "在技术问题上的信任程度。"),
        stateField("生活建议信任", formatNumber(profile.interaction_notes.trust_areas.life_advice), "在生活建议上的信任程度。"),
        stateField("情感支持信任", formatNumber(profile.interaction_notes.trust_areas.emotional_support), "在情感支持上的信任程度。"),
        stateField("娱乐内容信任", formatNumber(profile.interaction_notes.trust_areas.entertainment), "在娱乐和轻松内容上的信任程度。"),
        stateField("待确认条目", profile.pending_confirmations.length, "还没有和用户确认的推断条目数量。"),
        stateField("更新时间", formatLocalDateTime(profile.updated_at), "PROFILE 最近一次更新时间。")
      ]
    }
  ];

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {groups.map((group) => (
        <FieldGroup key={group.title} title={group.title} items={group.items} />
      ))}
    </div>
  );
}

function FieldGroup({
  title,
  items
}: {
  title: string;
  items: Array<{ label: string; value: string | number; description: string }>;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-white/70 p-4">
      <h3 className="mb-3 text-sm font-semibold text-foreground">{title}</h3>
      <div className="space-y-2">
        {items.map((item) => (
          <FieldRow
            key={`${title}-${item.label}`}
            label={item.label}
            value={item.value}
            description={item.description}
          />
        ))}
      </div>
    </div>
  );
}

function FieldRow({
  label,
  value,
  description
}: {
  label: string;
  value: string | number;
  description: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border/50 bg-background/70 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <span className="break-words">{label}</span>
        <InfoDot description={description} />
      </div>
      <div className="max-w-[65%] break-words whitespace-pre-wrap text-right font-mono text-sm leading-relaxed text-foreground">
        {String(value)}
      </div>
    </div>
  );
}

function InfoDot({ description }: { description: string }) {
  return (
    <span className="group relative inline-flex shrink-0">
      <button
        type="button"
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border bg-muted text-[10px] font-semibold text-muted-foreground"
        aria-label={description}
      >
        ?
      </button>
      <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 w-52 -translate-x-1/2 rounded-md border border-border/70 bg-background px-2 py-1.5 text-left text-xs font-normal leading-relaxed text-foreground opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
        {description}
      </span>
    </span>
  );
}

function stateField(label: string, value: string | number, description: string) {
  return { label, value, description };
}

function formatNumber(value: number): string {
  return value.toFixed(2);
}

function formatSignedNumber(value: number): string {
  return value >= 0 ? `+${value.toFixed(2)}` : value.toFixed(2);
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(" / ") : "无";
}

function formatPersonality(value: MindSnapshot["state"]["personality"]): string {
  return [
    `开放 ${formatNumber(value.openness)}`,
    `尽责 ${formatNumber(value.conscientiousness)}`,
    `外向 ${formatNumber(value.extraversion)}`,
    `宜人 ${formatNumber(value.agreeableness)}`,
    `神经质 ${formatNumber(value.neuroticism)}`
  ].join(" · ");
}

function formatLocalDateTime(value: string | null | undefined): string {
  if (!value) {
    return "无";
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
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
