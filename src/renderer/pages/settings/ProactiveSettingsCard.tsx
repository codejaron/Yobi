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

export function ProactiveSettingsCard({ config, setConfig }: ProactiveSettingsCardProps) {
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
      </CardContent>
    </Card>
  );
}
