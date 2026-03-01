import type { AppConfig } from "@shared/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@renderer/components/ui/card";
import { Label } from "@renderer/components/ui/label";
import { Switch } from "@renderer/components/ui/switch";

interface MessagingCardProps {
  config: AppConfig;
  setConfig: (next: AppConfig) => void;
}

export function MessagingCard({ config, setConfig }: MessagingCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>多模态消息</CardTitle>
        <CardDescription>语音/图片输入能力控制。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
          <Label>允许发语音</Label>
          <Switch
            checked={config.messaging.allowVoiceMessages}
            onChange={(checked) =>
              setConfig({
                ...config,
                messaging: {
                  ...config.messaging,
                  allowVoiceMessages: checked
                }
              })
            }
          />
        </div>

        <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
          <Label>允许图片输入理解</Label>
          <Switch
            checked={config.messaging.allowPhotoInput}
            onChange={(checked) =>
              setConfig({
                ...config,
                messaging: {
                  ...config.messaging,
                  allowPhotoInput: checked
                }
              })
            }
          />
        </div>
      </CardContent>
    </Card>
  );
}
