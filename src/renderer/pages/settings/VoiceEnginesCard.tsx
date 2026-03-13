import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppConfig } from "@shared/types";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@renderer/components/ui/card";
import { Input } from "@renderer/components/ui/input";
import { Label } from "@renderer/components/ui/label";

const LOCAL_MODEL = {
  value: "SenseVoiceSmall-int8" as AppConfig["senseVoiceLocal"]["modelName"],
  label: "SenseVoice-Small INT8",
  hint: "Q8_0 · 离线识别 + 语言 / 情感 / 事件"
};

interface VoiceEnginesCardProps {
  config: AppConfig;
  setConfig: (next: AppConfig) => void;
}

export function VoiceEnginesCard({ config, setConfig }: VoiceEnginesCardProps) {
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [runtimeEnabled, setRuntimeEnabled] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [ready, setReady] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const asrProvider = config.voice.asrProvider;
  const ttsProvider = config.voice.ttsProvider;
  const usingSenseVoice = asrProvider === "sensevoice-local";
  const usingAlibaba = asrProvider === "alibaba" || ttsProvider === "alibaba";
  const usingEdgeTts = ttsProvider === "edge";

  const refreshSenseVoiceStatus = useCallback(async () => {
    const status = await window.companion.getSenseVoiceModelStatus({
      modelName: config.senseVoiceLocal.modelName
    });
    setRuntimeEnabled(status.enabled);
    setDownloaded(status.downloaded);
    setReady(status.ready);
    setStatusError(status.errorMessage ?? null);
    return status;
  }, [config.senseVoiceLocal.modelName]);

  useEffect(() => {
    if (!usingSenseVoice) {
      return;
    }

    void refreshSenseVoiceStatus().catch(() => undefined);
  }, [refreshSenseVoiceStatus, usingSenseVoice]);

  useEffect(() => {
    return window.companion.onSenseVoiceModelDownloadProgress((event) => {
      if (event.modelName !== config.senseVoiceLocal.modelName) {
        return;
      }

      setDownloading(event.percent < 100);
      setDownloadProgress(event.percent);
    });
  }, [config.senseVoiceLocal.modelName]);

  useEffect(() => {
    if (!usingSenseVoice || !runtimeEnabled || !downloaded || ready || downloading) {
      return;
    }

    const timer = window.setTimeout(() => {
      void refreshSenseVoiceStatus().catch(() => undefined);
    }, 1000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [downloaded, downloading, ready, refreshSenseVoiceStatus, runtimeEnabled, usingSenseVoice]);

  const updateVoiceConfig = useCallback(
    (patch: Partial<AppConfig["voice"]>) => {
      setConfig({
        ...config,
        voice: {
          ...config.voice,
          ...patch
        }
      });
    },
    [config, setConfig]
  );

  const handleDownloadSenseVoiceModel = useCallback(async () => {
    if (downloading) {
      return;
    }

    setDownloading(true);
    setDownloadProgress(0);
    setNotice(null);

    try {
      await window.companion.ensureSenseVoiceModel({
        modelName: config.senseVoiceLocal.modelName
      });
      const status = await refreshSenseVoiceStatus();
      setNotice({
        type: "success",
        message: status.ready
          ? "模型下载完成，SenseVoice 已自动加载。"
          : "模型下载完成。配置会自动保存，应用将自动切换到本地 SenseVoice。"
      });
    } catch (error) {
      setNotice({
        type: "error",
        message: error instanceof Error ? error.message : "模型下载失败，请稍后重试。"
      });
    } finally {
      setDownloading(false);
      setDownloadProgress(null);
    }
  }, [config.senseVoiceLocal.modelName, downloading, refreshSenseVoiceStatus]);

  const senseVoiceStatusBadge = useMemo(() => {
    if (downloading) {
      return {
        className: "status-badge status-badge--info",
        label: `下载中 ${downloadProgress ?? 0}%`
      };
    }

    if (statusError) {
      return {
        className: "status-badge status-badge--danger",
        label: "不可用"
      };
    }

    if (ready) {
      return {
        className: "status-badge status-badge--success",
        label: "已加载"
      };
    }

    if (downloaded) {
      return {
        className: "status-badge status-badge--warn",
        label: "已下载"
      };
    }

    return {
      className: "status-badge status-badge--neutral",
      label: "未下载"
    };
  }, [downloadProgress, downloaded, downloading, ready, statusError]);

  const senseVoiceStatusHint = statusError
    ? statusError
    : downloaded && !ready
    ? runtimeEnabled
      ? "已下载；应用正在后台加载模型。"
      : "已下载；配置自动保存后，应用会切换到本地 SenseVoice。"
    : "下载后即可用于离线识别，并返回语言 / 情感 / 事件元信息。";

  return (
    <Card>
      <CardHeader>
        <CardTitle>语音引擎</CardTitle>
        <CardDescription>
          统一配置语音识别（ASR）和语音合成（TTS）。同一类型同一时间只能选择一个 provider。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="rounded-md border border-border/70 bg-white/70 p-3 text-xs text-muted-foreground">
          修改语音 provider、模型或凭证后，配置会自动保存并切换运行时引擎。
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>ASR 提供方</Label>
            <select
              className="flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              value={asrProvider}
              onChange={(event) =>
                updateVoiceConfig({
                  asrProvider: event.target.value as AppConfig["voice"]["asrProvider"]
                })
              }
            >
              <option value="none">无</option>
              <option value="sensevoice-local">本地 SenseVoice</option>
              <option value="alibaba">阿里百炼</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <Label>TTS 提供方</Label>
            <select
              className="flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              value={ttsProvider}
              onChange={(event) =>
                updateVoiceConfig({
                  ttsProvider: event.target.value as AppConfig["voice"]["ttsProvider"]
                })
              }
            >
              <option value="edge">Edge</option>
              <option value="alibaba">阿里百炼</option>
            </select>
          </div>
        </div>

        {usingSenseVoice ? (
          <div className="space-y-4 rounded-xl border border-border/70 bg-white/60 p-4">
            <div>
              <h3 className="text-sm font-medium text-foreground">本地 SenseVoice（ASR）</h3>
              <p className="text-xs text-muted-foreground">
                完全离线，不需要 API Key。首次使用需联网下载固定的 Small INT8 模型。
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>本地模型</Label>
              <div className="flex min-h-10 items-center rounded-md border border-border bg-background px-3 py-2 text-sm">
                {LOCAL_MODEL.label}
                <span className="ml-2 text-xs text-muted-foreground">{LOCAL_MODEL.hint}</span>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-white/70 px-3 py-3">
              <div className="space-y-1">
                <Label>模型状态</Label>
                <div className="flex items-center gap-2">
                  <Badge className={senseVoiceStatusBadge.className}>{senseVoiceStatusBadge.label}</Badge>
                  <span className="text-xs text-muted-foreground">{senseVoiceStatusHint}</span>
                </div>
              </div>

              <Button
                type="button"
                variant="outline"
                onClick={() => void handleDownloadSenseVoiceModel()}
                disabled={downloading}
              >
                {downloading ? "下载中..." : downloaded ? "刷新状态" : "下载模型"}
              </Button>
            </div>

            {downloading ? (
              <div className="space-y-2">
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-[width]"
                    style={{ width: `${downloadProgress ?? 0}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">正在下载模型文件，请保持网络连接。</p>
              </div>
            ) : null}
          </div>
        ) : null}

        {usingAlibaba ? (
          <div className="space-y-4 rounded-xl border border-border/70 bg-white/60 p-4">
            <div>
              <h3 className="text-sm font-medium text-foreground">阿里百炼语音</h3>
              <p className="text-xs text-muted-foreground">
                当前被用于{asrProvider === "alibaba" && ttsProvider === "alibaba"
                  ? " ASR 和 TTS"
                  : asrProvider === "alibaba"
                    ? " ASR"
                    : " TTS"}。
              </p>
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

            {asrProvider === "alibaba" ? (
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
            ) : null}

            {ttsProvider === "alibaba" ? (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
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
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {usingEdgeTts ? (
          <div className="space-y-4 rounded-xl border border-border/70 bg-white/60 p-4">
            <div>
              <h3 className="text-sm font-medium text-foreground">Edge TTS</h3>
              <p className="text-xs text-muted-foreground">仅用于语音合成（TTS）。</p>
            </div>

            <div className="space-y-1.5">
              <Label>Edge Voice 名称</Label>
              <Input
                value={config.voice.ttsVoice}
                placeholder="zh-CN-XiaoxiaoNeural"
                onChange={(event) => updateVoiceConfig({ ttsVoice: event.target.value })}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Edge 语速</Label>
                <Input
                  value={config.voice.ttsRate}
                  placeholder="+0%"
                  onChange={(event) => updateVoiceConfig({ ttsRate: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Edge 音高</Label>
                <Input
                  value={config.voice.ttsPitch}
                  placeholder="+0Hz"
                  onChange={(event) => updateVoiceConfig({ ttsPitch: event.target.value })}
                />
              </div>
            </div>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>请求超时（毫秒）</Label>
            <p className="text-xs text-muted-foreground">
              作用于阿里语音请求与 Edge TTS；本地 SenseVoice 不受影响。
            </p>
            <Input
              value={String(config.voice.requestTimeoutMs)}
              onChange={(event) =>
                updateVoiceConfig({
                  requestTimeoutMs:
                    Number.isFinite(Number(event.target.value))
                      ? Math.max(3000, Math.min(30000, Number(event.target.value)))
                      : config.voice.requestTimeoutMs
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>失败重试次数</Label>
            <p className="text-xs text-muted-foreground">
              作用于语音合成（阿里 TTS / Edge TTS）；语音识别不重试。
            </p>
            <Input
              value={String(config.voice.retryCount)}
              onChange={(event) =>
                updateVoiceConfig({
                  retryCount:
                    Number.isFinite(Number(event.target.value))
                      ? Math.max(0, Math.min(2, Number(event.target.value)))
                      : config.voice.retryCount
                })
              }
            />
          </div>
        </div>

        {notice ? (
          <p
            className={`text-sm ${
              notice.type === "error"
                ? "text-[hsl(var(--status-danger-foreground))]"
                : "text-[hsl(var(--status-success-foreground))]"
            }`}
          >
            {notice.message}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
