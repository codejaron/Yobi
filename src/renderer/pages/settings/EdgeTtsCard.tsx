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

interface EdgeTtsCardProps {
  config: AppConfig;
  setConfig: (next: AppConfig) => void;
}

export function EdgeTtsCard({ config, setConfig }: EdgeTtsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Edge TTS 设置</CardTitle>
        <CardDescription>
          仅在阿里语音未启用时生效；语速、音高等参数只作用于 Edge TTS。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label>Edge Voice 名称</Label>
          <Input
            value={config.voice.ttsVoice}
            placeholder="zh-CN-XiaoxiaoNeural"
            onChange={(event) =>
              setConfig({
                ...config,
                voice: {
                  ...config.voice,
                  ttsVoice: event.target.value
                }
              })
            }
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Edge 语速</Label>
            <Input
              value={config.voice.ttsRate}
              placeholder="+0%"
              onChange={(event) =>
                setConfig({
                  ...config,
                  voice: {
                    ...config.voice,
                    ttsRate: event.target.value
                  }
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>Edge 音高</Label>
            <Input
              value={config.voice.ttsPitch}
              placeholder="+0Hz"
              onChange={(event) =>
                setConfig({
                  ...config,
                  voice: {
                    ...config.voice,
                    ttsPitch: event.target.value
                  }
                })
              }
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Edge 合成超时（毫秒）</Label>
            <Input
              value={String(config.voice.requestTimeoutMs)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  voice: {
                    ...config.voice,
                    requestTimeoutMs:
                      Number.isFinite(Number(event.target.value))
                        ? Math.max(3000, Math.min(30000, Number(event.target.value)))
                        : config.voice.requestTimeoutMs
                  }
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>Edge 失败重试次数</Label>
            <Input
              value={String(config.voice.retryCount)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  voice: {
                    ...config.voice,
                    retryCount:
                      Number.isFinite(Number(event.target.value))
                        ? Math.max(0, Math.min(2, Number(event.target.value)))
                        : config.voice.retryCount
                  }
                })
              }
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
