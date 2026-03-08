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

interface FeishuChannelCardProps {
  config: AppConfig;
  setConfig: (next: AppConfig) => void;
}

export function FeishuChannelCard({ config, setConfig }: FeishuChannelCardProps) {
  const feishuEnabled = config.feishu.enabled;

  return (
    <Card>
      <CardHeader>
        <CardTitle>飞书通道</CardTitle>
        <CardDescription>启用后通过飞书机器人接收私聊消息（长连接事件模式）。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
          <Label>启用飞书通道</Label>
          <Switch
            checked={feishuEnabled}
            onChange={(checked) =>
              setConfig({
                ...config,
                feishu: {
                  ...config.feishu,
                  enabled: checked
                }
              })
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label>App ID</Label>
          <Input
            value={config.feishu.appId}
            disabled={!feishuEnabled}
            placeholder="cli_xxx"
            onChange={(event) =>
              setConfig({
                ...config,
                feishu: {
                  ...config.feishu,
                  appId: event.target.value
                }
              })
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label>App Secret</Label>
          <Input
            type="password"
            value={config.feishu.appSecret}
            disabled={!feishuEnabled}
            placeholder="请输入飞书应用密钥"
            onChange={(event) =>
              setConfig({
                ...config,
                feishu: {
                  ...config.feishu,
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
