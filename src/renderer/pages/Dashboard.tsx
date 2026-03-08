import {
  BarChart3,
  Bot,
  Clock3,
  ShieldCheck,
  Sparkles,
  PawPrint,
  MessageCircle
} from "lucide-react";
import type { AppStatus, PermissionState } from "@shared/types";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@renderer/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@renderer/components/ui/card";
import { Button } from "@renderer/components/ui/button";
import type { PageProps } from "@renderer/types";
import {
  aggregateTokenStats,
  type TokenPeriod
} from "@renderer/pages/dashboard/token-aggregate";

function formatDateTime(value: string | null): string {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString();
}

function formatPermission(value: PermissionState | undefined): string {
  if (value === "granted") {
    return "已授权";
  }
  if (value === "denied") {
    return "未授权";
  }
  return "未知";
}

function formatOpenClawStatus(value: string | undefined): string {
  if (!value) {
    return "状态未知";
  }

  if (value === "disabled") {
    return "已关闭（未启动）";
  }

  if (value === "checking") {
    return "正在检查安装状态";
  }

  if (value === "syncing-llm") {
    return "正在同步模型配置";
  }

  if (value === "starting-gateway") {
    return "正在启动 Gateway";
  }

  if (value === "online") {
    return "Gateway 已就绪";
  }

  if (value === "not-installed") {
    return "未安装 OpenClaw";
  }

  if (value === "gateway-exited") {
    return "Gateway 已退出";
  }

  if (value.startsWith("gateway-exited:code-")) {
    const code = value.replace("gateway-exited:code-", "").trim();
    return `Gateway 已退出（code=${code}）`;
  }

  if (value.startsWith("gateway-exited:signal-")) {
    const signal = value.replace("gateway-exited:signal-", "").trim();
    return `Gateway 被信号终止（${signal}）`;
  }

  if (value.startsWith("gateway-error:")) {
    return `Gateway 错误：${value.replace("gateway-error:", "").trim()}`;
  }

  return value;
}

function formatProactivePauseReason(value: string | null | undefined): string {
  if (!value) {
    return "主动消息可用";
  }
  if (value === "background-worker-unavailable") {
    return "主动消息已暂停：后台 Worker 不可用";
  }
  return `主动消息已暂停：${value}`;
}

function formatTokenCount(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString("zh-CN");
}

const TOKEN_PERIOD_ITEMS: Array<{
  value: TokenPeriod;
  label: string;
}> = [
  {
    value: "today",
    label: "今日"
  },
  {
    value: "7d",
    label: "7 天"
  },
  {
    value: "30d",
    label: "30 天"
  }
];

const TOKEN_SOURCE_COLORS = {
  chat: "#2B7088",
  background: "#D4854F"
} as const;

const SYSTEM_PERMISSION_ITEMS: Array<{
  key: keyof AppStatus["systemPermissions"];
  label: string;
}> = [
  {
    key: "accessibility",
    label: "辅助功能"
  },
  {
    key: "microphone",
    label: "麦克风"
  },
  {
    key: "screenCapture",
    label: "屏幕录制"
  }
];

export function DashboardPage({ status, refreshStatus }: Pick<PageProps, "status" | "refreshStatus">) {
  const [openingPermission, setOpeningPermission] = useState<keyof AppStatus["systemPermissions"] | null>(
    null
  );
  const [permissionActionNotice, setPermissionActionNotice] = useState<{
    type: "success" | "info" | "error";
    message: string;
  } | null>(null);
  const [resettingPermissions, setResettingPermissions] = useState(false);
  const [resetPermissionsNotice, setResetPermissionsNotice] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [tokenPeriod, setTokenPeriod] = useState<TokenPeriod>("today");

  useEffect(() => {
    if (!resetPermissionsNotice) {
      return;
    }

    const timer = setTimeout(() => {
      setResetPermissionsNotice(null);
    }, 3000);

    return () => {
      clearTimeout(timer);
    };
  }, [resetPermissionsNotice]);

  useEffect(() => {
    if (!permissionActionNotice) {
      return;
    }

    const timer = setTimeout(() => {
      setPermissionActionNotice(null);
    }, 3000);

    return () => {
      clearTimeout(timer);
    };
  }, [permissionActionNotice]);

  const tokenAggregate = useMemo(
    () =>
      aggregateTokenStats(status?.tokenStats, {
        period: tokenPeriod,
        narrowViewport: false
      }),
    [status?.tokenStats, tokenPeriod]
  );

  const openPermissionSettings = (permission: keyof AppStatus["systemPermissions"]): void => {
    if (openingPermission) {
      return;
    }

    setPermissionActionNotice(null);
    setOpeningPermission(permission);
    void (async () => {
      const latestStatus = await window.companion.getStatus();
      const current = latestStatus.systemPermissions[permission];
      if (current === "granted") {
        setPermissionActionNotice({
          type: "success",
          message: "该权限已授权"
        });
        return;
      }

      const result = await window.companion.openSystemPermissionSettings(permission);
      if (result.opened) {
        setPermissionActionNotice({
          type: "info",
          message: "已打开系统设置，请在隐私页授权"
        });
        return;
      }

      if (result.prompted) {
        await refreshStatus();
        const currentAfterPrompt = await window.companion.getStatus();
        if (currentAfterPrompt.systemPermissions[permission] === "granted") {
          setPermissionActionNotice({
            type: "success",
            message: "授权成功"
          });
          return;
        }

        setPermissionActionNotice({
          type: "info",
          message: "已触发系统授权弹窗，请先在弹窗内完成授权。"
        });
        return;
      }

      const currentAfter = await window.companion.getStatus();
      if (currentAfter.systemPermissions[permission] === "granted") {
        setPermissionActionNotice({
          type: "success",
          message: "授权成功"
        });
        return;
      }

      setPermissionActionNotice({
        type: "error",
        message: "未能自动打开权限页，请到系统设置手动授权。"
      });
    })()
      .catch((error) => {
        setPermissionActionNotice({
          type: "error",
          message: error instanceof Error ? error.message : "权限操作失败，请稍后重试。"
        });
      })
      .finally(() => {
        setOpeningPermission(null);
        void refreshStatus();
      });
  };
  const resetYobiPermissions = (): void => {
    if (resettingPermissions) {
      return;
    }

    setResettingPermissions(true);
    setResetPermissionsNotice(null);
    void window.companion
      .resetSystemPermissions()
      .then((result) => {
        if (result.reset) {
          setResetPermissionsNotice({
            type: "success",
            message: result.message ?? "已重置 Yobi 权限"
          });
          return;
        }

        setResetPermissionsNotice({
          type: "error",
          message: result.message ?? "重置权限失败，请稍后重试。"
        });
      })
      .catch((error) => {
        setResetPermissionsNotice({
          type: "error",
          message: error instanceof Error ? error.message : "重置权限失败，请稍后重试。"
        });
      })
      .finally(() => {
        setResettingPermissions(false);
      })
      .finally(() => void refreshStatus());
  };

  const donutData = useMemo(() => {
    const rows = [
      {
        key: "chat" as const,
        label: tokenAggregate.sourceTotals.chat.label,
        tokens: tokenAggregate.sourceTotals.chat.tokens,
        estimatedTokens: tokenAggregate.sourceTotals.chat.estimatedTokens,
        color: TOKEN_SOURCE_COLORS.chat
      },
      {
        key: "background" as const,
        label: tokenAggregate.sourceTotals.background.label,
        tokens: tokenAggregate.sourceTotals.background.tokens,
        estimatedTokens: tokenAggregate.sourceTotals.background.estimatedTokens,
        color: TOKEN_SOURCE_COLORS.background
      }
    ];

    const total = rows.reduce((sum, row) => sum + row.tokens, 0);
    const radius = 46;
    const circumference = 2 * Math.PI * radius;
    let offsetLength = 0;

    const segments = rows.map((row) => {
      const ratio = total > 0 ? row.tokens / total : 0;
      const length = circumference * ratio;
      const segment = {
        ...row,
        ratio,
        percent: ratio * 100,
        length,
        offsetLength
      };
      offsetLength += length;
      return segment;
    });

    return {
      total,
      circumference,
      segments
    };
  }, [
    tokenAggregate.sourceTotals.background.estimatedTokens,
    tokenAggregate.sourceTotals.background.label,
    tokenAggregate.sourceTotals.background.tokens,
    tokenAggregate.sourceTotals.chat.estimatedTokens,
    tokenAggregate.sourceTotals.chat.label,
    tokenAggregate.sourceTotals.chat.tokens
  ]);
  const currentPeriodLabel =
    tokenPeriod === "today" ? "今日" : tokenPeriod === "7d" ? "近 7 天" : "近 30 天";

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>QQ</CardDescription>
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageCircle className="h-4 w-4" />
              {status?.qqConnected ? "已连接" : "未连接"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Badge className={status?.qqConnected ? "border-emerald-300" : "border-amber-300"}>
              {status?.qqConnected ? "Bot 在线" : "等待配置"}
            </Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>飞书</CardDescription>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="h-4 w-4" />
              {status?.feishuConnected ? "已连接" : "未连接"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Badge className={status?.feishuConnected ? "border-emerald-300" : "border-amber-300"}>
              {status?.feishuConnected ? "Bot 在线" : "等待配置"}
            </Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Telegram</CardDescription>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="h-4 w-4" />
              {status?.telegramConnected ? "已连接" : "未连接"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Badge className={status?.telegramConnected ? "border-emerald-300" : "border-amber-300"}>
              {status?.telegramConnected ? "Bot 在线" : "等待配置"}
            </Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>OpenClaw</CardDescription>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4" />
              {status?.openclawOnline ? "在线" : "离线"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {formatOpenClawStatus(status?.openclawStatus)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>主动聊天</CardDescription>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock3 className="h-4 w-4" />
              最近主动消息
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {formatDateTime(status?.lastProactiveAt ?? null)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>语义记忆检索</CardDescription>
            <CardTitle className="text-base">
              Embedder：{status?.embedder.status ?? "unknown"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{status?.embedder.message || "未上报状态"}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>后台任务执行</CardDescription>
            <CardTitle className="text-base">
              {status?.backgroundWorker.available ? "Worker 可用" : "Worker 降级中"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{status?.backgroundWorker.message || "未上报状态"}</p>
            <p className="text-xs text-muted-foreground">
              {formatProactivePauseReason(status?.kernel?.proactivePausedReason)}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardDescription>Token 统计</CardDescription>
              <CardTitle className="flex items-center gap-2 text-base">
                <BarChart3 className="h-4 w-4" />
                使用概览
              </CardTitle>
            </div>
            <div className="inline-flex rounded-full border border-border/70 bg-white/75 p-1">
              {TOKEN_PERIOD_ITEMS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setTokenPeriod(item.value)}
                  className={`rounded-full px-3 py-1 text-xs transition ${
                    tokenPeriod === item.value
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-border/70 bg-white/75 px-4 py-3">
              <p className="text-xs text-muted-foreground">{currentPeriodLabel}总消耗</p>
              <p className="text-3xl font-semibold tracking-tight">{formatTokenCount(tokenAggregate.totalTokens)}</p>
              <p className="text-xs text-muted-foreground">单位：Tokens</p>
            </div>
            <div className="rounded-xl border border-border/70 bg-white/75 px-4 py-3 text-xs text-muted-foreground">
              <p>统计口径：优先 provider usage，缺失时回退估算。</p>
              <p>最后更新：{formatDateTime(tokenAggregate.lastUpdatedAt)}</p>
              {tokenAggregate.hasEstimated ? (
                <p className="text-amber-700">
                  本周期含估算值 {formatTokenCount(tokenAggregate.estimatedTokens)}
                </p>
              ) : (
                <p className="text-emerald-700">本周期全部为 provider 实际 usage。</p>
              )}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
            <div className="rounded-xl border border-border/70 bg-white/75 p-4">
              <div className="relative mx-auto h-56 w-56">
                <svg viewBox="0 0 128 128" className="h-full w-full -rotate-90">
                  <circle cx="64" cy="64" r="46" fill="none" stroke="rgba(122, 103, 87, 0.18)" strokeWidth="14" />
                  {donutData.segments.map((segment) =>
                    segment.tokens > 0 ? (
                      <circle
                        key={segment.key}
                        cx="64"
                        cy="64"
                        r="46"
                        fill="none"
                        stroke={segment.color}
                        strokeWidth="14"
                        strokeLinecap="round"
                        strokeDasharray={`${segment.length} ${Math.max(
                          0,
                          donutData.circumference - segment.length
                        )}`}
                        strokeDashoffset={-segment.offsetLength}
                      />
                    ) : null
                  )}
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                  <p className="text-xs text-muted-foreground">{currentPeriodLabel}</p>
                  <p className="text-2xl font-semibold">{formatTokenCount(donutData.total)}</p>
                  <p className="text-xs text-muted-foreground">功能分布</p>
                </div>
              </div>
              <p className="mt-2 text-center text-xs text-muted-foreground">
                来源占比
              </p>
            </div>

            <div className="space-y-3">
              {donutData.segments.map((segment) => (
                <div key={segment.key} className="rounded-xl border border-border/70 bg-white/75 p-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="inline-flex items-center gap-2 font-medium">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: segment.color }}
                        aria-hidden
                      />
                      {segment.label}
                    </span>
                    <span className="text-base font-semibold">{formatTokenCount(segment.tokens)}</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary/35">
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{
                        width: `${Math.max(0, Math.min(100, segment.percent))}%`,
                        backgroundColor: segment.color
                      }}
                    />
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{segment.percent.toFixed(segment.percent >= 10 ? 0 : 1)}%</span>
                    {segment.estimatedTokens > 0 ? (
                      <span>含估算 {formatTokenCount(segment.estimatedTokens)}</span>
                    ) : (
                      <span>全部实际 usage</span>
                    )}
                  </div>
                </div>
              ))}

              <div className="rounded-xl border border-border/70 bg-secondary/15 p-3">
                <p className="mb-2 text-xs text-muted-foreground">后台任务细分</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  {tokenAggregate.backgroundDetails.map((item) => (
                    <div key={item.label} className="rounded-lg border border-border/60 bg-white/70 px-3 py-2">
                      <p className="text-[11px] text-muted-foreground">{item.label}</p>
                      <p className="text-sm font-medium">{formatTokenCount(item.tokens)}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between rounded-xl border border-dashed border-border/70 bg-white/55 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Claw</span>
                <span className="text-muted-foreground">{tokenAggregate.sourceTotals.claw.label}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardDescription>系统权限</CardDescription>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4" />
              权限管理
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {SYSTEM_PERMISSION_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => openPermissionSettings(item.key)}
                disabled={openingPermission !== null}
                className="flex w-full items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2 text-sm transition-colors hover:bg-secondary/40"
              >
                <span>{item.label}</span>
                <span className="text-muted-foreground">
                  {formatPermission(status?.systemPermissions?.[item.key])}
                </span>
              </button>
            ))}
            {permissionActionNotice ? (
              <p
                className={`text-xs ${
                  permissionActionNotice.type === "success"
                    ? "text-emerald-700"
                    : permissionActionNotice.type === "info"
                      ? "text-slate-700"
                      : "text-rose-700"
                }`}
              >
                {permissionActionNotice.message}
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={resetYobiPermissions} disabled={resettingPermissions}>
                {resettingPermissions ? "重置中..." : "重置 Yobi 权限"}
              </Button>
              {resetPermissionsNotice ? (
                <span
                  className={`text-xs ${
                    resetPermissionsNotice.type === "success" ? "text-emerald-700" : "text-rose-700"
                  }`}
                >
                  {resetPermissionsNotice.message}
                </span>
              ) : null}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>桌宠与后台</CardDescription>
            <CardTitle className="flex items-center gap-2 text-base">
              <PawPrint className="h-4 w-4" />
              {status?.petOnline ? "桌宠在线" : "桌宠离线"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              保活 {status?.keepAwakeActive ? "已启用" : "未启用"} · 历史消息 {status?.historyCount ?? 0} 条
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
