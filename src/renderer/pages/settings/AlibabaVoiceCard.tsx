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

interface AlibabaVoiceCardProps {
  config: AppConfig;
  setConfig: (next: AppConfig) => void;
}

export function AlibabaVoiceCard({ config, setConfig }: AlibabaVoiceCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>阿里百炼语音</CardTitle>
        <CardDescription>
          开启且填写 API Key 后，语音识别和语音合成都会走阿里 WebSocket。未满足条件时回退到 Edge TTS。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
          <Label>启用阿里语音（STT + TTS）</Label>
          <Switch
            checked={config.alibabaVoice.enabled}
            onChange={(checked) =>
              setConfig({
                ...config,
                alibabaVoice: {
                  ...config.alibabaVoice,
                  enabled: checked
                }
              })
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label>DashScope API Key</Label>
          <Input
            type="password"
            value={config.alibabaVoice.apiKey}
            placeholder="sk-xxxx"
            onChange={(event) =>
              setConfig({
                ...config,
                alibabaVoice: {
                  ...config.alibabaVoice,
                  apiKey: event.target.value
                }
              })
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label>区域</Label>
          <select
            className="flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            value={config.alibabaVoice.region}
            onChange={(event) =>
              setConfig({
                ...config,
                alibabaVoice: {
                  ...config.alibabaVoice,
                  region: event.target.value === "intl" ? "intl" : "cn"
                }
              })
            }
          >
            <option value="cn">中国内地（dashscope.aliyuncs.com）</option>
            <option value="intl">国际站（dashscope-intl.aliyuncs.com）</option>
          </select>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>ASR 模型</Label>
            <Input
              value={config.alibabaVoice.asrModel}
              placeholder="fun-asr-realtime"
              onChange={(event) =>
                setConfig({
                  ...config,
                  alibabaVoice: {
                    ...config.alibabaVoice,
                    asrModel: event.target.value
                  }
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>TTS 模型</Label>
            <Input
              value={config.alibabaVoice.ttsModel}
              placeholder="cosyvoice-v3-flash"
              onChange={(event) =>
                setConfig({
                  ...config,
                  alibabaVoice: {
                    ...config.alibabaVoice,
                    ttsModel: event.target.value
                  }
                })
              }
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>TTS 音色</Label>
          <Input
            value={config.alibabaVoice.ttsVoice}
            placeholder="longxiaochun_v3"
            onChange={(event) =>
              setConfig({
                ...config,
                alibabaVoice: {
                  ...config.alibabaVoice,
                  ttsVoice: event.target.value
                }
              })
            }
          />
        </div>
      </CardContent>
    </Card>
  );
}
