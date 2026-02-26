import { Bot, Clock3, ShieldCheck, Sparkles, AlarmClock, PawPrint } from "lucide-react";
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

function formatPermission(value: "granted" | "denied" | "unknown" | undefined): string {
  if (value === "granted") {
    return "已授权";
  }
  if (value === "denied") {
    return "未授权";
  }
  return "未知";
}

export function DashboardPage({ status, refreshStatus }: Pick<PageProps, "status" | "refreshStatus">) {
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
            <CardDescription>系统权限</CardDescription>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4" />
              辅助功能
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              辅助功能 {formatPermission(status?.macAccessibilityPermission)}
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

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">运行时间线</CardTitle>
          <CardDescription>帮助你确认主动聊天触发是否符合预期</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center justify-between rounded-md bg-secondary/45 px-3 py-2">
            <span className="flex items-center gap-2">
              <Clock3 className="h-4 w-4" /> 最近用户消息
            </span>
            <span>{formatDateTime(status?.lastUserAt ?? null)}</span>
          </div>
          <div className="flex items-center justify-between rounded-md bg-secondary/45 px-3 py-2">
            <span className="flex items-center gap-2">
              <Clock3 className="h-4 w-4" /> 最近主动消息
            </span>
            <span>{formatDateTime(status?.lastProactiveAt ?? null)}</span>
          </div>
          <Button variant="outline" onClick={() => void refreshStatus()}>
            刷新状态
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
