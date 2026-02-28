import { Bot, Clock3, ShieldCheck, Sparkles, AlarmClock, PawPrint } from "lucide-react";
import type { AppStatus, PermissionState } from "@shared/types";
import { useEffect, useState } from "react";
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

  if (value === "installing") {
    return "正在自动安装 OpenClaw";
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
    return "未安装，且自动安装已关闭";
  }

  if (value === "gateway-exited") {
    return "Gateway 已退出";
  }

  if (value.startsWith("gateway-error:")) {
    return `Gateway 错误：${value.replace("gateway-error:", "").trim()}`;
  }

  return value;
}

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

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="animate-float">
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
            <CardDescription>提醒任务</CardDescription>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlarmClock className="h-4 w-4" />
              {status?.pendingReminders ?? 0} 条待执行
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              到点后会主动 Telegram 推送，可用 /reminders 与 /cancel 管理。
            </p>
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
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
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
