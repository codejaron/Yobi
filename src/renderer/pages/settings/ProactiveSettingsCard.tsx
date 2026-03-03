import { useState } from "react";
import type { AppConfig } from "@shared/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@renderer/components/ui/card";
import { Input } from "@renderer/components/ui/input";
import { Label } from "@renderer/components/ui/label";
import { Switch } from "@renderer/components/ui/switch";

interface ProactiveSettingsCardProps {
  config: AppConfig;
  setConfig: (next: AppConfig) => void;
}

function minuteOfDayToTime(minuteOfDay: number): string {
  const normalized = ((minuteOfDay % 1440) + 1440) % 1440;
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function timeToMinuteOfDay(value: string): number | null {
  const matched = /^(\d{2}):(\d{2})$/.exec(value);
  if (!matched) {
    return null;
  }

  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return null;
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  return hour * 60 + minute;
}

export function ProactiveSettingsCard({ config, setConfig }: ProactiveSettingsCardProps) {
  const [quietHoursNotice, setQuietHoursNotice] = useState("");
  const quietHours = config.proactive.quietHours;

  const setQuietHoursMinute = (
    key: "startMinuteOfDay" | "endMinuteOfDay",
    value: string
  ): void => {
    const minute = timeToMinuteOfDay(value);
    if (minute === null) {
      return;
    }

    const counterpart =
      key === "startMinuteOfDay" ? quietHours.endMinuteOfDay : quietHours.startMinuteOfDay;
    if (minute === counterpart) {
      setQuietHoursNotice("开始时间和结束时间不能相同。");
      return;
    }

    setQuietHoursNotice("");
    setConfig({
      ...config,
      proactive: {
        ...config.proactive,
        quietHours: {
          ...quietHours,
          [key]: minute
        }
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>主动聊天参数</CardTitle>
        <CardDescription>
          关闭时只被动回复；开启后按冷却与沉默规则触发主动消息。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
          <Label>启用主动聊天</Label>
          <Switch
            checked={config.proactive.enabled}
            onChange={(checked) =>
              setConfig({
                ...config,
                proactive: {
                  ...config.proactive,
                  enabled: checked
                }
              })
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label>冷却时间（毫秒）</Label>
          <Input
            type="number"
            min={10_000}
            value={String(config.proactive.cooldownMs)}
            onChange={(event) =>
              setConfig({
                ...config,
                proactive: {
                  ...config.proactive,
                  cooldownMs: Number(event.target.value) || config.proactive.cooldownMs
                }
              })
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label>沉默阈值（毫秒）</Label>
          <Input
            type="number"
            min={60_000}
            value={String(config.proactive.silenceThresholdMs)}
            onChange={(event) =>
              setConfig({
                ...config,
                proactive: {
                  ...config.proactive,
                  silenceThresholdMs:
                    Number(event.target.value) || config.proactive.silenceThresholdMs
                }
              })
            }
          />
        </div>

        <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
          <Label>启用夜间静默</Label>
          <Switch
            checked={quietHours.enabled}
            onChange={(checked) =>
              setConfig({
                ...config,
                proactive: {
                  ...config.proactive,
                  quietHours: {
                    ...quietHours,
                    enabled: checked
                  }
                }
              })
            }
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>静默开始</Label>
            <Input
              type="time"
              value={minuteOfDayToTime(quietHours.startMinuteOfDay)}
              onChange={(event) => setQuietHoursMinute("startMinuteOfDay", event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>静默结束</Label>
            <Input
              type="time"
              value={minuteOfDayToTime(quietHours.endMinuteOfDay)}
              onChange={(event) => setQuietHoursMinute("endMinuteOfDay", event.target.value)}
            />
          </div>
        </div>

        <p className="text-xs text-muted-foreground">支持跨天设置，例如 23:00-07:00。</p>
        {quietHoursNotice ? <p className="text-xs text-rose-700">{quietHoursNotice}</p> : null}
      </CardContent>
    </Card>
  );
}
