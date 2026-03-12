import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AppConfig,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskRun,
  ScheduledTaskToolName
} from "@shared/types";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@renderer/components/ui/card";
import { Input } from "@renderer/components/ui/input";
import { Label } from "@renderer/components/ui/label";
import { Select } from "@renderer/components/ui/select";
import { Switch } from "@renderer/components/ui/switch";
import { Textarea } from "@renderer/components/ui/textarea";

interface SchedulerPageProps {
  config: AppConfig;
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return "-";
  }

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value.trim())) {
    const normalized = value.trim().replace("T", " ");
    return normalized.length === 16 ? `${normalized}:00` : normalized;
  }

  return new Date(value).toLocaleString();
}

function toDateTimeLocalValue(value: string | null): string {
  if (!value) {
    return "";
  }

  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed)) {
    return `${trimmed}:00`;
  }
  return trimmed.slice(0, 19);
}

function fromDateTimeLocalValue(value: string): string {
  return value.trim();
}

function statusTone(status: ScheduledTask["status"]): string {
  if (status === "enabled") {
    return "status-badge status-badge--success";
  }
  if (status === "paused") {
    return "status-badge status-badge--warn";
  }
  if (status === "completed") {
    return "status-badge status-badge--info";
  }
  return "status-badge status-badge--danger";
}

function defaultAgentTools(config: AppConfig): ScheduledTaskToolName[] {
  const defaults: ScheduledTaskToolName[] = [];
  if (config.tools.exa.enabled) {
    defaults.push("web_search", "web_fetch", "code_search");
  }
  if (config.tools.browser.enabled) {
    defaults.push("browser");
  }
  return defaults;
}

export function SchedulerPage({ config }: SchedulerPageProps) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [runs, setRuns] = useState<ScheduledTaskRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string>("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [triggerKind, setTriggerKind] = useState<"once" | "cron">("once");
  const [runAt, setRunAt] = useState("");
  const [cronExpression, setCronExpression] = useState("0 9 * * *");
  const [actionKind, setActionKind] = useState<"notify" | "agent">("notify");
  const [notifyText, setNotifyText] = useState("");
  const [pushTelegram, setPushTelegram] = useState(config.proactive.pushTargets.telegram);
  const [pushFeishu, setPushFeishu] = useState(config.proactive.pushTargets.feishu);
  const [agentPrompt, setAgentPrompt] = useState("");
  const [allowedTools, setAllowedTools] = useState<ScheduledTaskToolName[]>(() => defaultAgentTools(config));
  const isEditing = Boolean(editingId);
  const toolOptions = useMemo(
    () =>
      [
        { name: "web_search", label: "web_search", enabled: config.tools.exa.enabled },
        { name: "web_fetch", label: "web_fetch", enabled: config.tools.exa.enabled },
        { name: "code_search", label: "code_search", enabled: config.tools.exa.enabled },
        { name: "browser", label: "browser", enabled: config.tools.browser.enabled },
        { name: "system", label: "system", enabled: config.tools.system.enabled },
        { name: "file", label: "file", enabled: config.tools.file.readEnabled || config.tools.file.writeEnabled }
      ] satisfies Array<{ name: ScheduledTaskToolName; label: string; enabled: boolean }>,
    [
      config.tools.browser.enabled,
      config.tools.exa.enabled,
      config.tools.file.readEnabled,
      config.tools.file.writeEnabled,
      config.tools.system.enabled
    ]
  );

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    try {
      const snapshot = await window.companion.listScheduledTasks();
      setTasks(snapshot.tasks);
      setRuns(snapshot.runs);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  const resetForm = useCallback(() => {
    setEditingId(null);
    setNotice("");
    setName("");
    setEnabled(true);
    setTriggerKind("once");
    setRunAt("");
    setCronExpression("0 9 * * *");
    setActionKind("notify");
    setNotifyText("");
    setPushTelegram(config.proactive.pushTargets.telegram);
    setPushFeishu(config.proactive.pushTargets.feishu);
    setAgentPrompt("");
    setAllowedTools(defaultAgentTools(config));
  }, [config]);

  const sortedRuns = useMemo(() => [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20), [runs]);

  const submit = async () => {
    setSaving(true);
    setNotice("");
    try {
      const action: ScheduledTaskInput["action"] =
        actionKind === "notify"
          ? {
              kind: "notify",
              text: notifyText,
              pushTargets: {
                telegram: pushTelegram,
                feishu: pushFeishu
              }
            }
          : {
              kind: "agent",
              prompt: agentPrompt,
              pushTargets: {
                telegram: pushTelegram,
                feishu: pushFeishu
              },
              allowedTools
            };

      const payload: ScheduledTaskInput = {
        id: editingId ?? undefined,
        name: name.trim() || undefined,
        trigger:
          triggerKind === "once"
            ? {
                kind: "once",
                runAt: fromDateTimeLocalValue(runAt)
              }
            : {
                kind: "cron",
                expression: cronExpression.trim(),
                timezone: "local"
              },
        action,
        enabled
      };

      await window.companion.saveScheduledTask(payload);
      setNotice(editingId ? "任务已更新。" : "任务已创建。");
      resetForm();
      await loadSnapshot();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const startEditing = (task: ScheduledTask) => {
    setEditingId(task.id);
    setName(task.name);
    setEnabled(task.status === "enabled");
    if (task.trigger.kind === "once") {
      setTriggerKind("once");
      setRunAt(toDateTimeLocalValue(task.trigger.runAt));
    } else {
      setTriggerKind("cron");
      setCronExpression(task.trigger.expression);
    }

    if (task.action.kind === "notify") {
      setActionKind("notify");
      setNotifyText(task.action.text);
      setPushTelegram(task.action.pushTargets?.telegram ?? config.proactive.pushTargets.telegram);
      setPushFeishu(task.action.pushTargets?.feishu ?? config.proactive.pushTargets.feishu);
    } else {
      setActionKind("agent");
      setAgentPrompt(task.action.prompt);
      setAllowedTools(task.action.allowedTools);
      setPushTelegram(task.action.pushTargets?.telegram ?? config.proactive.pushTargets.telegram);
      setPushFeishu(task.action.pushTargets?.feishu ?? config.proactive.pushTargets.feishu);
    }
  };

  const cancelEditing = () => {
    resetForm();
  };

  const toggleAllowedTool = (toolName: ScheduledTaskToolName) => {
    setAllowedTools((current) =>
      current.includes(toolName) ? current.filter((item) => item !== toolName) : [...current, toolName].sort()
    );
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{editingId ? "编辑定时任务" : "新建定时任务"}</CardTitle>
          <CardDescription>统一管理提醒与定时自动执行任务。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className={isEditing ? "space-y-1.5" : "space-y-1.5 sm:col-span-2"}>
              <Label>任务名</Label>
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：每天早上搜索新闻" />
            </div>
            {isEditing ? (
              <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
                <Label>启用</Label>
                <Switch checked={enabled} onChange={setEnabled} />
              </div>
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>触发方式</Label>
              <Select value={triggerKind} onChange={(event) => setTriggerKind(event.target.value as "once" | "cron") }>
                <option value="once">一次</option>
                <option value="cron">Cron</option>
              </Select>
            </div>
            {triggerKind === "once" ? (
              <div className="space-y-1.5">
                <Label>执行时间</Label>
                <Input type="datetime-local" step={1} value={runAt} onChange={(event) => setRunAt(event.target.value)} />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>Cron 表达式</Label>
                <Input value={cronExpression} onChange={(event) => setCronExpression(event.target.value)} placeholder="0 9 * * *" />
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>动作类型</Label>
            <Select value={actionKind} onChange={(event) => setActionKind(event.target.value as "notify" | "agent") }>
              <option value="notify">提醒</option>
              <option value="agent">Agent</option>
            </Select>
          </div>

          {actionKind === "notify" ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label>提醒内容</Label>
                <Textarea rows={4} value={notifyText} onChange={(event) => setNotifyText(event.target.value)} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
                  <Label>推送 Telegram</Label>
                  <Switch checked={pushTelegram} onChange={setPushTelegram} />
                </div>
                <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
                  <Label>推送飞书</Label>
                  <Switch checked={pushFeishu} onChange={setPushFeishu} />
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label>Agent 指令</Label>
                <Textarea
                  rows={5}
                  value={agentPrompt}
                  onChange={(event) => setAgentPrompt(event.target.value)}
                  placeholder="例如：搜索 GitHub Trending 前十，并告诉我每个项目是做什么的。"
                />
              </div>
              <div className="space-y-2">
                <Label>允许调用的工具</Label>
                <div className="grid gap-3 sm:grid-cols-2">
                  {toolOptions.map((tool) => (
                    <div key={tool.name} className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
                      <div>
                        <p className="text-sm font-medium">{tool.label}</p>
                        <p className="text-xs text-muted-foreground">{tool.enabled ? "已启用" : "当前设置里未启用"}</p>
                      </div>
                      <Switch
                        checked={allowedTools.includes(tool.name)}
                        onChange={(checked) => {
                          if (!tool.enabled && checked) {
                            return;
                          }
                          toggleAllowedTool(tool.name);
                        }}
                      />
                    </div>
                  ))}
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
                  <Label>推送 Telegram</Label>
                  <Switch checked={pushTelegram} onChange={setPushTelegram} />
                </div>
                <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
                  <Label>推送飞书</Label>
                  <Switch checked={pushFeishu} onChange={setPushFeishu} />
                </div>
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <Button type="button" onClick={() => void submit()} disabled={saving}>
              {saving ? "保存中..." : editingId ? "保存任务" : "创建任务"}
            </Button>
            {isEditing ? (
              <Button type="button" variant="outline" onClick={cancelEditing}>
                取消编辑
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={resetForm}>
                清空表单
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>任务列表</CardTitle>
          <CardDescription>{loading ? "加载中..." : `共 ${tasks.length} 个任务`}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无定时任务。</p>
          ) : (
            tasks.map((task) => (
              <div key={task.id} className="space-y-3 rounded-md border border-border/70 bg-white/70 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{task.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {task.action.kind === "notify" ? "提醒" : "Agent"} · {task.trigger.kind === "once" ? formatDateTime(task.trigger.runAt) : task.trigger.expression}
                    </p>
                  </div>
                  <Badge className={statusTone(task.status)}>{task.status}</Badge>
                </div>

                <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                  <div>下次执行：{formatDateTime(task.nextRunAt)}</div>
                  <div>上次执行：{formatDateTime(task.lastRunAt)}</div>
                  <div>最近结果：{task.lastRunMessage ?? "-"}</div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => startEditing(task)}>
                    编辑
                  </Button>
                  {task.status === "paused" ? (
                    <Button type="button" variant="outline" size="sm" onClick={() => void window.companion.resumeScheduledTask(task.id).then(loadSnapshot)}>
                      恢复
                    </Button>
                  ) : task.status === "enabled" ? (
                    <Button type="button" variant="outline" size="sm" onClick={() => void window.companion.pauseScheduledTask(task.id).then(loadSnapshot)}>
                      暂停
                    </Button>
                  ) : null}
                  <Button type="button" variant="outline" size="sm" onClick={() => void window.companion.runScheduledTaskNow(task.id).then(loadSnapshot)}>
                    立即执行
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => void window.companion.deleteScheduledTask(task.id).then(loadSnapshot)}>
                    删除
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>最近执行记录</CardTitle>
          <CardDescription>展示最近 20 条调度器运行记录。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {sortedRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无执行记录。</p>
          ) : (
            sortedRuns.map((run) => (
              <div key={run.id} className="rounded-md border border-border/70 bg-white/70 p-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">{run.taskName}</p>
                    <p className="text-xs text-muted-foreground">计划时间：{formatDateTime(run.scheduledFor)}</p>
                  </div>
                  <Badge className={run.status === "success" ? "status-badge status-badge--success" : "status-badge status-badge--warn"}>
                    {run.status}
                  </Badge>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">开始：{formatDateTime(run.startedAt)} · 结束：{formatDateTime(run.finishedAt)}</p>
                <p className="mt-2 text-xs text-muted-foreground">{run.error ?? run.message ?? "-"}</p>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
