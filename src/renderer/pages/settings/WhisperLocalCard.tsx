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
import { Label } from "@renderer/components/ui/label";
import { Switch } from "@renderer/components/ui/switch";

const MODEL_OPTIONS: Array<{
  value: AppConfig["whisperLocal"]["modelSize"];
  label: string;
  hint: string;
}> = [
  { value: "tiny", label: "tiny", hint: "75MB · 最快" },
  { value: "base", label: "base", hint: "148MB · 推荐" },
  { value: "small", label: "small", hint: "488MB · 最准" }
];

interface WhisperLocalCardProps {
  config: AppConfig;
  setConfig: (next: AppConfig) => void;
}

export function WhisperLocalCard({ config, setConfig }: WhisperLocalCardProps) {
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [runtimeEnabled, setRuntimeEnabled] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const refreshStatus = useCallback(async () => {
    const status = await window.companion.getWhisperModelStatus({
      modelSize: config.whisperLocal.modelSize
    });
    setRuntimeEnabled(status.enabled);
    setDownloaded(status.downloaded);
    setReady(status.ready);
  }, [config.whisperLocal.enabled, config.whisperLocal.modelSize]);

  useEffect(() => {
    void refreshStatus().catch(() => undefined);
  }, [refreshStatus]);

  useEffect(() => {
    return window.companion.onWhisperModelDownloadProgress((event) => {
      if (event.modelSize !== config.whisperLocal.modelSize) {
        return;
      }

      setDownloading(event.percent < 100);
      setDownloadProgress(event.percent);
    });
  }, [config.whisperLocal.modelSize]);

  useEffect(() => {
    if (!runtimeEnabled || !downloaded || ready || downloading) {
      return;
    }

    const timer = window.setTimeout(() => {
      void refreshStatus().catch(() => undefined);
    }, 1000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [downloaded, downloading, ready, refreshStatus, runtimeEnabled]);

  const handleDownload = useCallback(async () => {
    if (downloading) {
      return;
    }

    setDownloading(true);
    setDownloadProgress(0);
    setNotice(null);

    try {
      await window.companion.ensureWhisperModel({
        modelSize: config.whisperLocal.modelSize
      });
      await refreshStatus();
      setNotice({
        type: "success",
        message: "模型下载完成。若当前已启用 Whisper，应用会在后台自动加载。"
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
  }, [config.whisperLocal.modelSize, downloading, refreshStatus]);

  const statusBadge = useMemo(() => {
    if (downloading) {
      return {
        className: "border-sky-300",
        label: `下载中 ${downloadProgress ?? 0}%`
      };
    }

    if (ready) {
      return {
        className: "border-emerald-300",
        label: "已加载"
      };
    }

    if (downloaded) {
      return {
        className: "border-amber-300",
        label: "已下载"
      };
    }

    return {
      className: "border-border/70",
      label: "未下载"
    };
  }, [downloadProgress, downloaded, downloading, ready]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>本地语音识别</CardTitle>
        <CardDescription>
          Whisper 只负责 ASR（语音转文字）。启用后优先使用本地离线识别；TTS 仍走阿里或 Edge。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
          <div className="space-y-1">
            <Label>启用本地 Whisper</Label>
            <p className="text-xs text-muted-foreground">
              本地识别完全离线，不需要 API Key。首次使用需联网下载模型文件。
            </p>
          </div>
          <Switch
            checked={config.whisperLocal.enabled}
            onChange={(checked) =>
              setConfig({
                ...config,
                whisperLocal: {
                  ...config.whisperLocal,
                  enabled: checked
                }
              })
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label>模型选择</Label>
          <select
            className="flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            value={config.whisperLocal.modelSize}
            disabled={downloading}
            onChange={(event) =>
              setConfig({
                ...config,
                whisperLocal: {
                  ...config.whisperLocal,
                  modelSize: event.target.value as AppConfig["whisperLocal"]["modelSize"]
                }
              })
            }
          >
            {MODEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}（{option.hint}）
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-white/70 px-3 py-3">
          <div className="space-y-1">
            <Label>模型状态</Label>
            <div className="flex items-center gap-2">
              <Badge className={statusBadge.className}>{statusBadge.label}</Badge>
              <span className="text-xs text-muted-foreground">
                {downloaded && !ready
                  ? runtimeEnabled
                    ? "已下载；应用正在后台加载模型。"
                    : "已下载；保存配置后会在后台加载。"
                  : "下载后即可用于离线识别。"}
              </span>
            </div>
          </div>

          <Button type="button" variant="outline" onClick={() => void handleDownload()} disabled={downloading}>
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

        {notice ? (
          <p className={`text-sm ${notice.type === "error" ? "text-rose-600" : "text-emerald-600"}`}>
            {notice.message}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
