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

interface TelegramChannelCardProps {
  config: AppConfig;
  setConfig: (next: AppConfig) => void;
}

export function TelegramChannelCard({ config, setConfig }: TelegramChannelCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Telegram 通道</CardTitle>
        <CardDescription>填入 Bot Token 和目标 Chat ID，保存后自动重连。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label>Bot Token</Label>
          <Input
            type="password"
            value={config.telegram.botToken}
            onChange={(event) =>
              setConfig({
                ...config,
                telegram: {
                  ...config.telegram,
                  botToken: event.target.value
                }
              })
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label>Chat ID</Label>
          <Input
            value={config.telegram.chatId}
            placeholder="例如: 123456789"
            onChange={(event) =>
              setConfig({
                ...config,
                telegram: {
                  ...config.telegram,
                  chatId: event.target.value
                }
              })
            }
          />
        </div>

        <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
          <Label>主动消息不再推送到 Telegram</Label>
          <Switch
            checked={config.proactive.localOnly}
            onChange={(checked) =>
              setConfig({
                ...config,
                proactive: {
                  ...config.proactive,
                  localOnly: checked
                }
              })
            }
          />
        </div>
      </CardContent>
    </Card>
  );
}
