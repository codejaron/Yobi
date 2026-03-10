import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import type { AppConfig, AppStatus, BrowseAuthState } from "@shared/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@renderer/components/ui/card";
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

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString();
}

export function BilibiliBrowseCard({ config, status, setConfig }: BilibiliBrowseCardProps) {
  const [manualCookie, setManualCookie] = useState(config.browse.bilibiliCookie);
  const [savingCookie, setSavingCookie] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [openingAccount, setOpeningAccount] = useState(false);
  const [qrSession, setQrSession] = useState<QrSession | null>(null);
  const [qrImageSrc, setQrImageSrc] = useState<string>("");
  const [notice, setNotice] = useState<string>("");

  useEffect(() => {
    setManualCookie(config.browse.bilibiliCookie);
  }, [config.browse.bilibiliCookie]);


  useEffect(() => {
    if (!qrSession?.scanUrl) {
      setQrImageSrc("");
      return;
    }

    let cancelled = false;
    void QRCode.toDataURL(qrSession.scanUrl, {
      margin: 1,
      width: 220,
      color: {
        dark: "#0f172a",
        light: "#ffffff"
      }
    })
      .then((dataUrl) => {
        if (!cancelled) {
          setQrImageSrc(dataUrl);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setQrImageSrc("");
          setNotice(error instanceof Error ? error.message : "二维码生成失败。");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [qrSession?.scanUrl]);

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
          setConfig(latest);
          setNotice("扫码登录成功，B 站 Cookie 已更新。\n素材同步器会按 6 小时节奏自动运行。");
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
        <CardTitle>B 站素材同步</CardTitle>
        <CardDescription>扫码登录后每 6 小时同步一次 B 站内容，写入 Yobi 的素材记忆，不再参与主动打断。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
          <Label>启用 B 站素材同步</Label>
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

        <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
          <div>
            <Label>允许自动关注</Label>
            <p className="text-xs text-muted-foreground">冷启动和长期低频维护时，Yobi 可以少量自动关注新 UP。</p>
          </div>
          <Switch
            checked={config.browse.autoFollowEnabled}
            onChange={(checked) =>
              setConfig({
                ...config,
                browse: {
                  ...config.browse,
                  autoFollowEnabled: checked
                }
              })
            }
          />
        </div>

        <div className="rounded-md border border-border/70 bg-white/70 px-3 py-2 text-xs text-muted-foreground">
          <p>登录状态：{authText}</p>
          <p>最近鉴权：{formatDateTime(browseStatus?.lastNavCheckAt)}</p>
          <p>最近同步：{formatDateTime(browseStatus?.lastSyncAt)}</p>
          <p>稳定偏好 facts：{browseStatus?.preferenceFactCount ?? 0}</p>
          <p>近期素材 facts：{browseStatus?.recentFactCount ?? 0}</p>
          <p>最近自动关注：{formatDateTime(browseStatus?.lastAutoFollowAt)}</p>
          <p>今日自动关注次数：{browseStatus?.autoFollowTodayCount ?? 0}</p>
          {browseStatus?.pausedReason ? <p>当前状态：{browseStatus.pausedReason}</p> : null}
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
            <div className="rounded-md border border-dashed border-border/70 bg-white p-3 text-xs text-muted-foreground">
              <img src={qrImageSrc || undefined} alt="Bilibili QR" className="h-44 w-44 rounded-md border border-border/60 bg-white object-contain" />
              <p className="mt-2 break-all">扫码链接：{qrSession.scanUrl}</p>
              <p>过期时间：{new Date(qrSession.expiresAt).toLocaleString()}</p>
            </div>
          ) : null}
        </div>

        <div className="space-y-2 rounded-md border border-border/70 bg-white/70 p-3">
          <Label htmlFor="bilibili-cookie">B 站 Cookie</Label>
          <Textarea
            id="bilibili-cookie"
            value={manualCookie}
            onChange={(event) => setManualCookie(event.target.value)}
            placeholder="粘贴 SESSDATA / bili_jct / DedeUserID 等 Cookie"
            rows={5}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={savingCookie}
              onClick={() => {
                setSavingCookie(true);
                setNotice("");
                void window.companion
                  .saveBilibiliCookie({
                    cookie: manualCookie.trim()
                  })
                  .then(async (result) => {
                    const latest = await window.companion.getConfig();
                    setConfig(latest);
                    setNotice(result.message);
                  })
                  .catch((error) => {
                    setNotice(error instanceof Error ? error.message : "保存 Cookie 失败。");
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

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={syncing}
            onClick={() => {
              setSyncing(true);
              setNotice("");
              void window.companion
                .triggerBilibiliSync()
                .then((result) => {
                  setNotice(result.message);
                })
                .catch((error) => {
                  setNotice(error instanceof Error ? error.message : "同步失败，请稍后重试。");
                })
                .finally(() => {
                  setSyncing(false);
                });
            }}
          >
            {syncing ? "同步中..." : "立即同步"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={openingAccount}
            onClick={() => {
              setOpeningAccount(true);
              setNotice("");
              void window.companion
                .openBilibiliAccount()
                .then((result) => {
                  setNotice(result.message);
                })
                .catch((error) => {
                  setNotice(error instanceof Error ? error.message : "打开主页失败。");
                })
                .finally(() => {
                  setOpeningAccount(false);
                });
            }}
          >
            {openingAccount ? "打开中..." : "打开 Yobi 的 B 站账号"}
          </Button>
        </div>

        <div className="space-y-2 rounded-md border border-border/70 bg-white/70 p-3">
          <p className="text-sm font-medium">最近自动关注</p>
          {browseStatus?.recentAutoFollows?.length ? (
            <div className="space-y-2 text-xs text-muted-foreground">
              {browseStatus.recentAutoFollows.slice(0, 5).map((entry) => (
                <div key={`${entry.followedAt}-${entry.upMid}`} className="rounded-md border border-border/60 bg-white px-3 py-2">
                  <p className="font-medium text-foreground">{entry.upName}</p>
                  <p>时间：{new Date(entry.followedAt).toLocaleString()}</p>
                  <p>原因：{entry.reason}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">还没有自动关注记录。</p>
          )}
        </div>

        {notice ? <p className="whitespace-pre-line text-xs text-muted-foreground">{notice}</p> : null}
      </CardContent>
    </Card>
  );
}
