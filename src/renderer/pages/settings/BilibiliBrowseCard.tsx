import { useEffect, useMemo, useState } from "react";
import type { AppConfig, AppStatus, BrowseAuthState } from "@shared/types";
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
import { Button } from "@renderer/components/ui/button";
import { Textarea } from "@renderer/components/ui/textarea";

interface BilibiliBrowseCardProps {
  config: AppConfig;
  status: AppStatus | null;
  setConfig: (next: AppConfig) => void;
}

interface QrSession {
  qrcodeKey: string;
  scanUrl: string;
  expiresAt: string;
}

function formatAuthState(state: BrowseAuthState): string {
  if (state === "active") {
    return "已登录";
  }
  if (state === "pending") {
    return "等待扫码";
  }
  if (state === "expired") {
    return "已过期";
  }
  if (state === "error") {
    return "异常";
  }
  return "未配置";
}

export function BilibiliBrowseCard({ config, status, setConfig }: BilibiliBrowseCardProps) {
  const [manualCookie, setManualCookie] = useState(config.browse.bilibiliCookie);
  const [savingCookie, setSavingCookie] = useState(false);
  const [qrSession, setQrSession] = useState<QrSession | null>(null);
  const [notice, setNotice] = useState<string>("");

  useEffect(() => {
    setManualCookie(config.browse.bilibiliCookie);
  }, [config.browse.bilibiliCookie]);

  useEffect(() => {
    if (!qrSession) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (cancelled) {
        return;
      }

      if (new Date(qrSession.expiresAt).getTime() <= Date.now()) {
        setNotice("二维码已过期，请重新生成。");
        setQrSession(null);
        return;
      }

      try {
        const result = await window.companion.pollBilibiliQrAuth({
          qrcodeKey: qrSession.qrcodeKey
        });

        if (result.status === "confirmed") {
          const latest = await window.companion.getConfig();
          setConfig({
            ...config,
            browse: {
              ...config.browse,
              bilibiliCookie: latest.browse.bilibiliCookie
            }
          });
          setNotice("扫码登录成功，Cookie 已写入配置。");
          setQrSession(null);
          return;
        }

        if (result.status === "expired" || result.status === "error") {
          setNotice(result.detail || "扫码流程已结束，请重试。");
          setQrSession(null);
          return;
        }

        timer = setTimeout(() => {
          void poll();
        }, 2500);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "扫码轮询失败，请稍后重试。");
        setQrSession(null);
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [config, qrSession, setConfig]);

  const browseStatus = status?.browseStatus;
  const authText = useMemo(() => formatAuthState(browseStatus?.authState ?? "missing"), [browseStatus?.authState]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>B 站内容感知</CardTitle>
        <CardDescription>扫码登录后自动采集关注动态和热门内容，生成主动聊天话题。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
          <Label>启用 B 站浏览感知</Label>
          <Switch
            checked={config.browse.enabled}
            onChange={(checked) =>
              setConfig({
                ...config,
                browse: {
                  ...config.browse,
                  enabled: checked
                }
              })
            }
          />
        </div>

        <div className="rounded-md border border-border/70 bg-white/70 px-3 py-2 text-xs text-muted-foreground">
          <p>登录状态：{authText}</p>
          <p>最近鉴权：{browseStatus?.lastNavCheckAt ? new Date(browseStatus.lastNavCheckAt).toLocaleString() : "-"}</p>
          <p>最近采集：{browseStatus?.lastCollectAt ? new Date(browseStatus.lastCollectAt).toLocaleString() : "-"}</p>
          <p>最近摘要：{browseStatus?.lastDigestAt ? new Date(browseStatus.lastDigestAt).toLocaleString() : "-"}</p>
          <p>今日 Token：{browseStatus?.todayTokenUsed ?? 0} / {config.browse.tokenBudgetDaily}</p>
          <p>今日事件抢占：{browseStatus?.todayEventShares ?? 0} / {config.browse.eventDailyCap}</p>
          {browseStatus?.pausedReason ? <p>暂停原因：{browseStatus.pausedReason}</p> : null}
        </div>

        <div className="space-y-2 rounded-md border border-border/70 bg-white/70 p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">扫码登录</p>
            <Button
              size="sm"
              onClick={() => {
                setNotice("");
                void window.companion
                  .startBilibiliQrAuth()
                  .then((session) => {
                    setQrSession({
                      qrcodeKey: session.qrcodeKey,
                      scanUrl: session.scanUrl,
                      expiresAt: session.expiresAt
                    });
                    setNotice("二维码已生成，请用 B 站 App 扫码并确认。");
                  })
                  .catch((error) => {
                    setNotice(error instanceof Error ? error.message : "生成二维码失败。");
                  });
              }}
            >
              {qrSession ? "重新生成二维码" : "生成二维码"}
            </Button>
          </div>

          {qrSession ? (
            <div className="space-y-2">
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(qrSession.scanUrl)}`}
                alt="Bilibili QR"
                className="h-40 w-40 rounded border border-border/70 bg-white"
              />
              <p className="break-all text-xs text-muted-foreground">扫码链接：{qrSession.scanUrl}</p>
              <p className="text-xs text-muted-foreground">
                过期时间：{new Date(qrSession.expiresAt).toLocaleTimeString()}
              </p>
            </div>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label>手动 Cookie（扫码失败时兜底）</Label>
          <Textarea
            value={manualCookie}
            rows={4}
            placeholder="粘贴 SESSDATA=...; bili_jct=...; DedeUserID=..."
            onChange={(event) => {
              setManualCookie(event.target.value);
            }}
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={savingCookie}
              onClick={() => {
                if (savingCookie) {
                  return;
                }

                setSavingCookie(true);
                setNotice("");
                void window.companion
                  .saveBilibiliCookie({
                    cookie: manualCookie
                  })
                  .then((result) => {
                    setNotice(result.message);
                    setConfig({
                      ...config,
                      browse: {
                        ...config.browse,
                        bilibiliCookie: manualCookie.trim()
                      }
                    });
                  })
                  .catch((error) => {
                    setNotice(error instanceof Error ? error.message : "Cookie 保存失败。");
                  })
                  .finally(() => {
                    setSavingCookie(false);
                  });
              }}
            >
              {savingCookie ? "保存中..." : "保存 Cookie"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setManualCookie("");
              }}
            >
              清空输入
            </Button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>采集周期（毫秒）</Label>
            <Input
              type="number"
              min={60_000}
              value={config.browse.collectIntervalMs}
              onChange={(event) =>
                setConfig({
                  ...config,
                  browse: {
                    ...config.browse,
                    collectIntervalMs: Math.max(60_000, Number(event.target.value) || 60_000)
                  }
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>Digest 周期（毫秒）</Label>
            <Input
              type="number"
              min={60_000}
              value={config.browse.digestIntervalMs}
              onChange={(event) =>
                setConfig({
                  ...config,
                  browse: {
                    ...config.browse,
                    digestIntervalMs: Math.max(60_000, Number(event.target.value) || 60_000)
                  }
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>事件检查周期（毫秒）</Label>
            <Input
              type="number"
              min={60_000}
              value={config.browse.eventCheckIntervalMs}
              onChange={(event) =>
                setConfig({
                  ...config,
                  browse: {
                    ...config.browse,
                    eventCheckIntervalMs: Math.max(60_000, Number(event.target.value) || 60_000)
                  }
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>每日 Token 预算</Label>
            <Input
              type="number"
              min={100}
              value={config.browse.tokenBudgetDaily}
              onChange={(event) =>
                setConfig({
                  ...config,
                  browse: {
                    ...config.browse,
                    tokenBudgetDaily: Math.max(100, Number(event.target.value) || 100)
                  }
                })
              }
            />
          </div>
        </div>

        {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
      </CardContent>
    </Card>
  );
}
