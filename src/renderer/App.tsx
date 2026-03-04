import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AppConfig,
  AppStatus,
  MindSnapshot
} from "@shared/types";
import { SideNav } from "@renderer/components/layout/SideNav";
import { Button } from "@renderer/components/ui/button";
import { Badge } from "@renderer/components/ui/badge";
import { DashboardPage } from "@renderer/pages/Dashboard";
import { TopicPoolPage } from "@renderer/pages/TopicPool";
import { ConsoleChatPage } from "@renderer/pages/ConsoleChat";
import { ProvidersPage } from "@renderer/pages/Providers";
import { MemoryPage } from "@renderer/pages/Memory";
import { McpPage } from "@renderer/pages/Mcp";
import { SettingsPage } from "@renderer/pages/Settings";
import type { PageId } from "./types";

function pageTitle(page: PageId): string {
  switch (page) {
    case "dashboard":
      return "运行仪表盘";
    case "topics":
      return "话题池";
    case "providers":
      return "Provider 与模型路由";
    case "console":
      return "聊天控制台";
    case "memory":
      return "Mind Center";
    case "mcp":
      return "MCP 工具中心";
    case "settings":
      return "行为与通道设置";
    default:
      return "Yobi Companion";
  }
}

export default function App() {
  const [activePage, setActivePage] = useState<PageId>("dashboard");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [mindSnapshot, setMindSnapshot] = useState<MindSnapshot | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("启动中...");

  const refreshStatus = useCallback(async (): Promise<void> => {
    const next = await window.companion.getStatus();
    setStatus(next);
  }, []);

  const refreshMindSnapshot = useCallback(async (): Promise<void> => {
    const doc = await window.companion.getMindSnapshot();
    setMindSnapshot(doc);
  }, []);

  useEffect(() => {
    let unsubStatus: (() => void) | null = null;
    let unsubPetEnabled: (() => void) | null = null;

    const load = async (): Promise<void> => {
      const [nextConfig, nextStatus, nextMindSnapshot] = await Promise.all([
        window.companion.getConfig(),
        window.companion.getStatus(),
        window.companion.getMindSnapshot()
      ]);

      setConfig(nextConfig);
      setStatus(nextStatus);
      setMindSnapshot(nextMindSnapshot);
      setNotice("就绪");

      unsubStatus = window.companion.onStatus((update) => {
        setStatus(update);
      });

      unsubPetEnabled = window.companion.onPetEnabledChange((enabled) => {
        setConfig((current) => {
          if (!current || current.pet.enabled === enabled) {
            return current;
          }

          return {
            ...current,
            pet: {
              ...current.pet,
              enabled
            }
          };
        });
        if (!enabled) {
          setNotice("桌宠已退出（开关已同步关闭）");
        }
      });
    };

    void load();

    return () => {
      unsubStatus?.();
      unsubPetEnabled?.();
    };
  }, []);

  useEffect(() => {
    const onFocus = () => {
      void refreshStatus();
    };

    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshStatus]);

  const saveConfig = useCallback(async () => {
    if (!config) {
      return;
    }

    setSaving(true);
    try {
      const saved = await window.companion.saveConfig(config);
      setConfig(saved);
      setNotice(`已保存 (${new Date().toLocaleTimeString()})`);
      await refreshStatus();
    } finally {
      setSaving(false);
    }
  }, [config, refreshStatus]);

  const content = useMemo(() => {
    if (!config) {
      return <div className="text-sm text-muted-foreground">正在加载配置...</div>;
    }

    if (activePage === "dashboard") {
      return <DashboardPage status={status} refreshStatus={refreshStatus} />;
    }

    if (activePage === "console") {
      return <ConsoleChatPage />;
    }

    if (activePage === "topics") {
      return <TopicPoolPage status={status} refreshStatus={refreshStatus} />;
    }

    if (activePage === "providers") {
      return <ProvidersPage config={config} setConfig={setConfig} />;
    }

    if (activePage === "memory") {
      return (
        <MemoryPage
          snapshot={mindSnapshot}
          onSaveSoul={async (markdown) => {
            await window.companion.saveSoul({
              markdown
            });
            await refreshMindSnapshot();
            setNotice("SOUL 已更新");
          }}
          onSavePersona={async (markdown) => {
            await window.companion.savePersona({
              markdown
            });
            await refreshMindSnapshot();
            setNotice("PERSONA 已更新");
          }}
          onTriggerKernelTask={async (taskType) => {
            const result = await window.companion.triggerKernelTask(taskType);
            await refreshMindSnapshot();
            return result;
          }}
          onRefresh={async () => {
            await refreshMindSnapshot();
            setNotice("已刷新 Mind 快照");
          }}
        />
      );
    }

    if (activePage === "mcp") {
      return <McpPage config={config} setConfig={setConfig} />;
    }

    return <SettingsPage config={config} status={status} setConfig={setConfig} />;
  }, [activePage, config, refreshStatus, status, mindSnapshot, refreshMindSnapshot]);

  return (
    <div className="mx-auto grid min-h-screen max-w-[1440px] gap-6 p-6 lg:grid-cols-[248px_1fr]">
      <SideNav active={activePage} onSelect={setActivePage} />

      <main className="space-y-4">
        {activePage === "console" ? null : (
          <header className="glass-panel flex items-center justify-between p-4">
            <div>
              <h1 className="font-display text-2xl tracking-wide">{pageTitle(activePage)}</h1>
              <p className="text-sm text-muted-foreground">{notice}</p>
            </div>

            <div className="flex items-center gap-3">
              <Badge>{status?.telegramConnected ? "Telegram Online" : "Telegram Offline"}</Badge>
              <Badge>{status?.qqConnected ? "QQ Online" : "QQ Offline"}</Badge>
              <Button onClick={() => void saveConfig()} disabled={saving || !config}>
                {saving ? "保存中..." : "保存配置"}
              </Button>
            </div>
          </header>
        )}

        {content}
      </main>
    </div>
  );
}
