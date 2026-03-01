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

interface QQChannelCardProps {
  config: AppConfig;
  setConfig: (next: AppConfig) => void;
}

export function QQChannelCard({ config, setConfig }: QQChannelCardProps) {
  const qqEnabled = config.qq.enabled;

  return (
    <Card>
      <CardHeader>
        <CardTitle>QQ 通道</CardTitle>
        <CardDescription>启用后通过 QQ 机器人接收 C2C 私聊消息。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
          <Label>启用 QQ 私聊通道</Label>
          <Switch
            checked={qqEnabled}
            onChange={(checked) =>
              setConfig({
                ...config,
                qq: {
                  ...config.qq,
                  enabled: checked
                }
              })
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label>App ID</Label>
          <Input
            value={config.qq.appId}
            disabled={!qqEnabled}
            placeholder="请输入 QQ 机器人 App ID"
            onChange={(event) =>
              setConfig({
                ...config,
                qq: {
                  ...config.qq,
                  appId: event.target.value
                }
              })
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label>AppSecret</Label>
          <Input
            type="password"
            value={config.qq.appSecret}
            disabled={!qqEnabled}
            placeholder="请输入 QQ 机器人 AppSecret"
            onChange={(event) =>
              setConfig({
                ...config,
                qq: {
                  ...config.qq,
                  appSecret: event.target.value
                }
              })
            }
          />
        </div>

      </CardContent>
    </Card>
  );
}
