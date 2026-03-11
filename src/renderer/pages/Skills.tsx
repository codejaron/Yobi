import { useCallback, useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import type { SkillCatalogItem } from "@shared/types";
import { MarkdownContent } from "@renderer/components/chat/MarkdownContent";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@renderer/components/ui/card";
import { Switch } from "@renderer/components/ui/switch";

function compatibilityTone(status: SkillCatalogItem["compatibility"]["status"]): string {
  if (status === "compatible") {
    return "status-badge status-badge--success";
  }
  if (status === "partial") {
    return "status-badge status-badge--warn";
  }
  return "status-badge status-badge--danger";
}

function resourceSummary(skill: SkillCatalogItem): Array<{ key: string; count: number }> {
  return [
    { key: "scripts", count: skill.resourceEntries.filter((item) => item.kind === "script").length },
    { key: "references", count: skill.resourceEntries.filter((item) => item.kind === "reference").length },
    { key: "assets", count: skill.resourceEntries.filter((item) => item.kind === "asset").length },
    { key: "templates", count: skill.resourceEntries.filter((item) => item.kind === "template").length }
  ].filter((item) => item.count > 0);
}

export function SkillsPage() {
  const [skills, setSkills] = useState<SkillCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [notice, setNotice] = useState("正在扫描 skills...");

  const loadSkills = useCallback(async (label = "已刷新 skills") => {
    setLoading(true);
    try {
      const next = await window.companion.listSkills();
      setSkills(next);
      setSelectedSkillId((current) => current ?? next[0]?.id ?? null);
      setNotice(label);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "加载 skills 失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const selected = useMemo(
    () => skills.find((item) => item.id === selectedSkillId) ?? skills[0] ?? null,
    [selectedSkillId, skills]
  );

  const handleRescan = useCallback(async () => {
    setBusy(true);
    try {
      const next = await window.companion.rescanSkills();
      setSkills(next);
      setSelectedSkillId((current) => current ?? next[0]?.id ?? null);
      setNotice(`重新加载完成，共 ${next.length} 个 skill`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "重新加载失败");
    } finally {
      setBusy(false);
    }
  }, []);

  const handleImport = useCallback(async () => {
    setBusy(true);
    try {
      const result = await window.companion.importSkillFolder();
      if (result.canceled) {
        setNotice("已取消导入");
        return;
      }

      const next = await window.companion.listSkills();
      setSkills(next);
      setSelectedSkillId(result.skill?.id ?? next[0]?.id ?? null);
      setNotice(result.skill ? `已导入 ${result.skill.name}` : "导入完成");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "导入失败");
    } finally {
      setBusy(false);
    }
  }, []);

  const handleToggle = useCallback(async (skillId: string, enabled: boolean) => {
    setBusy(true);
    try {
      const updated = await window.companion.setSkillEnabled({ skillId, enabled });
      setSkills((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setNotice(`${updated.name} 已${enabled ? "启用" : "停用"}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "更新 skill 状态失败");
    } finally {
      setBusy(false);
    }
  }, []);

  const handleDelete = useCallback(async (skill: SkillCatalogItem) => {
    const confirmed = window.confirm(`确认删除 skill「${skill.name}」吗？此操作会删除本地目录，无法撤销。`);
    if (!confirmed) {
      return;
    }

    setBusy(true);
    try {
      await window.companion.deleteSkill(skill.id);
      const next = await window.companion.listSkills();
      setSkills(next);
      setSelectedSkillId((current) => {
        if (current !== skill.id) {
          return current ?? next[0]?.id ?? null;
        }

        return next[0]?.id ?? null;
      });
      setNotice(`${skill.name} 已删除`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "删除 skill 失败");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
      <Card className="min-h-[560px]">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Skills Catalog</CardTitle>
              <CardDescription>{notice}</CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void handleRescan()} disabled={busy}>
                重新加载
              </Button>
              <Button size="sm" onClick={() => void handleImport()} disabled={busy}>
                导入文件夹
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <p className="text-sm text-muted-foreground">正在加载 skills...</p>
          ) : skills.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-sm text-muted-foreground">
              还没有已安装 skill。点击“导入文件夹”把包含 `SKILL.md` 的目录复制进 `/Users/jaron/.yobi/skills`。
            </p>
          ) : (
            skills.map((skill) => (
              <button
                key={skill.id}
                type="button"
                onClick={() => setSelectedSkillId(skill.id)}
                className={`w-full rounded-2xl border p-4 text-left transition ${
                  selected?.id === skill.id
                    ? "border-primary bg-primary/5 shadow-sm"
                    : "border-border/70 bg-white/70 hover:border-primary/30 hover:bg-white"
                }`}
              >
                <div className="flex items-start gap-4">
                  <div className="min-w-0 flex-1 space-y-1 pr-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{skill.name}</span>
                      <Badge className={compatibilityTone(skill.compatibility.status)}>
                        {skill.compatibility.status}
                      </Badge>
                      {skill.version ? <Badge className="status-badge status-badge--neutral">v{skill.version}</Badge> : null}
                    </div>
                    <p className="line-clamp-2 text-sm text-muted-foreground">{skill.description}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <Switch
                      className="mt-0.5"
                      checked={skill.enabled}
                      onChange={(checked: boolean) => {
                        void handleToggle(skill.id, checked);
                      }}
                      onClick={(event) => event.stopPropagation()}
                      disabled={busy}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="theme-danger-button h-8 w-8 p-0"
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleDelete(skill);
                      }}
                      disabled={busy}
                      aria-label={`删除 `}
                      title={`删除 `}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {skill.tags.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {skill.tags.map((tag) => (
                      <Badge key={tag} className="status-badge status-badge--neutral">{tag}</Badge>
                    ))}
                  </div>
                ) : null}
              </button>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="min-h-[560px]">
        <CardHeader>
          <CardTitle>{selected?.name ?? "Skill 详情"}</CardTitle>
          <CardDescription>{selected?.directoryPath ?? "选择左侧 skill 查看详情"}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {selected ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Badge className={compatibilityTone(selected.compatibility.status)}>
                  {selected.compatibility.status}
                </Badge>
                <Badge className="status-badge status-badge--neutral">{selected.enabled ? "已启用" : "已停用"}</Badge>
                {resourceSummary(selected).map((item) => (
                  <Badge key={item.key} className="status-badge status-badge--neutral">{item.key}: {item.count}</Badge>
                ))}
              </div>

              {selected.compatibility.issues.length > 0 ? (
                <div className="status-surface status-surface--warn rounded-xl px-4 py-3 text-sm">
                  <p className="font-medium">兼容提示</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {selected.compatibility.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {selected.resourceEntries.length > 0 ? (
                <div className="rounded-xl border border-border/70 bg-secondary/30 px-4 py-3 text-sm">
                  <p className="font-medium text-foreground">已索引资源</p>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {selected.resourceEntries.map((entry) => (
                      <span key={`${entry.kind}:${entry.relativePath}`} className="rounded-md bg-white px-2 py-1">
                        {entry.kind}: {entry.relativePath}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="rounded-2xl border border-border/70 bg-white/80 px-4 py-4">
                <p className="mb-3 text-sm font-medium text-foreground">SKILL.md 预览</p>
                {selected.markdownPreview ? (
                  <MarkdownContent variant="chat" markdown={selected.markdownPreview} />
                ) : (
                  <p className="text-sm text-muted-foreground">暂无预览内容。</p>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">左侧选择一个 skill 查看详情。</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
