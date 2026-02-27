import { Bot, Clock3, ShieldCheck, Sparkles, AlarmClock, PawPrint } from "lucide-react";
import type { AppStatus, PermissionState } from "@shared/types";
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
  const openPermissionSettings = (permission: keyof AppStatus["systemPermissions"]): void => {
    void window.companion
      .openSystemPermissionSettings(permission)
      .finally(() => void refreshStatus());
  };
  const resetYobiPermissions = (): void => {
    void window.companion
      .resetSystemPermissions()
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
            <CardDescription>长期记忆</CardDescription>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4" />
              {status?.memoryFacts ?? 0} 条事实
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">每隔一定轮次自动提炼，也支持手动编辑。</p>
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
                className="flex w-full items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2 text-sm transition-colors hover:bg-secondary/40"
              >
                <span>{item.label}</span>
                <span className="text-muted-foreground">
                  {formatPermission(status?.systemPermissions?.[item.key])}
                </span>
              </button>
            ))}
            <p className="text-xs text-muted-foreground">
              点击任一权限可打开系统设置授权页。
            </p>
            <Button variant="outline" onClick={resetYobiPermissions}>
              重置 Yobi 权限
            </Button>
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
