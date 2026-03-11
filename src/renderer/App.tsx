import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type {
  AppConfig,
  AppStatus,
  MindSnapshot
} from "@shared/types";
import { SideNav } from "@renderer/components/layout/SideNav";
import { Button } from "@renderer/components/ui/button";
import { Badge } from "@renderer/components/ui/badge";
import type { PageId } from "./types";

const DashboardPage = lazy(async () => {
  const module = await import("@renderer/pages/Dashboard");
  return { default: module.DashboardPage };
});
const TopicPoolPage = lazy(async () => {
  const module = await import("@renderer/pages/TopicPool");
  return { default: module.TopicPoolPage };
});
const ConsoleChatPage = lazy(async () => {
  const module = await import("@renderer/pages/ConsoleChat");
  return { default: module.ConsoleChatPage };
});
const SchedulerPage = lazy(async () => {
  const module = await import("@renderer/pages/Scheduler");
  return { default: module.SchedulerPage };
});
const SkillsPage = lazy(async () => {
  const module = await import("@renderer/pages/Skills");
  return { default: module.SkillsPage };
});
const ProvidersPage = lazy(async () => {
  const module = await import("@renderer/pages/Providers");
  return { default: module.ProvidersPage };
});
const MemoryPage = lazy(async () => {
  const module = await import("@renderer/pages/Memory");
  return { default: module.MemoryPage };
});
const McpPage = lazy(async () => {
  const module = await import("@renderer/pages/Mcp");
  return { default: module.McpPage };
});
const SettingsPage = lazy(async () => {
  const module = await import("@renderer/pages/Settings");
  return { default: module.SettingsPage };
});

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
    case "scheduler":
      return "定时任务";
    case "skills":
      return "Skills";
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

  const loadWithTimeout = useCallback(async <T,>(promise: Promise<T>, label: string, timeoutMs = 5000): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error(`${label} 超时`));
      }, timeoutMs);

      promise
        .then((value) => resolve(value))
        .catch((error) => reject(error))
        .finally(() => {
          window.clearTimeout(timer);
        });
    });
  }, []);

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      const next = await loadWithTimeout(window.companion.getStatus(), "状态加载");
      setStatus(next);
    } catch (error) {
      console.error("[app] refreshStatus failed:", error);
    }
  }, [loadWithTimeout]);

  const refreshMindSnapshot = useCallback(async (): Promise<void> => {
    try {
      const doc = await loadWithTimeout(window.companion.getMindSnapshot(), "Mind 快照加载");
      setMindSnapshot(doc);
    } catch (error) {
      console.error("[app] refreshMindSnapshot failed:", error);
    }
  }, [loadWithTimeout]);

  useEffect(() => {
    let unsubStatus: (() => void) | null = null;
    let unsubPetEnabled: (() => void) | null = null;

    const load = async (): Promise<void> => {
      if (!window.companion) {
        setNotice("预加载失败：window.companion 不存在");
        return;
      }

      try {
        const nextConfig = await loadWithTimeout(window.companion.getConfig(), "配置加载");
        setConfig(nextConfig);
      } catch (error) {
        console.error("[app] initial config load failed:", error);
        setNotice(error instanceof Error ? `配置加载失败：${error.message}` : "配置加载失败");
        return;
      }

      setNotice("配置已加载，正在同步状态...");

      const [statusResult, mindSnapshotResult] = await Promise.allSettled([
        loadWithTimeout(window.companion.getStatus(), "状态加载"),
        loadWithTimeout(window.companion.getMindSnapshot(), "Mind 快照加载")
      ]);

      if (statusResult.status === "fulfilled") {
        setStatus(statusResult.value);
      } else {
        console.error("[app] initial status load failed:", statusResult.reason);
      }

      if (mindSnapshotResult.status === "fulfilled") {
        setMindSnapshot(mindSnapshotResult.value);
      } else {
        console.error("[app] initial mind snapshot load failed:", mindSnapshotResult.reason);
      }

      if (statusResult.status === "rejected" || mindSnapshotResult.status === "rejected") {
        setNotice("部分状态加载失败，界面已降级显示");
      } else {
        setNotice("就绪");
      }

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

    void load().catch((error) => {
      console.error("[app] initial load failed:", error);
      setNotice(error instanceof Error ? error.message : "初始化失败");
    });

    return () => {
      unsubStatus?.();
      unsubPetEnabled?.();
    };
  }, [loadWithTimeout]);

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

    if (!status && activePage === "dashboard") {
      return (
        <div className="space-y-3 text-sm text-muted-foreground">
          <div>配置已加载，但运行状态暂时不可用。</div>
          <div>可以先切到“设置 / Provider / 记忆”等页面继续查看配置。</div>
        </div>
      );
    }

    const loading = <div className="text-sm text-muted-foreground">页面加载中...</div>;

    if (activePage === "dashboard") {
      return (
        <Suspense fallback={loading}>
          <DashboardPage status={status} refreshStatus={refreshStatus} />
        </Suspense>
      );
    }

    if (activePage === "console") {
      return (
        <Suspense fallback={loading}>
          <ConsoleChatPage />
        </Suspense>
      );
    }

    if (activePage === "scheduler") {
      return (
        <Suspense fallback={loading}>
          <SchedulerPage config={config} />
        </Suspense>
      );
    }

    if (activePage === "skills") {
      return (
        <Suspense fallback={loading}>
          <SkillsPage />
        </Suspense>
      );
    }

    if (activePage === "topics") {
      return (
        <Suspense fallback={loading}>
          <TopicPoolPage status={status} refreshStatus={refreshStatus} />
        </Suspense>
      );
    }

    if (activePage === "providers") {
      return (
        <Suspense fallback={loading}>
          <ProvidersPage config={config} setConfig={setConfig} />
        </Suspense>
      );
    }

    if (activePage === "memory") {
      return (
        <Suspense fallback={loading}>
          <MemoryPage
            snapshot={mindSnapshot}
            onSaveSoul={async (markdown) => {
              await window.companion.saveSoul({ markdown });
              await refreshMindSnapshot();
              setNotice("SOUL 已更新");
            }}
            onSavePersona={async (markdown) => {
              await window.companion.savePersona({ markdown });
              await refreshMindSnapshot();
              setNotice("PERSONA 已更新");
            }}
            onResetMindSection={async (input) => {
              const result = await window.companion.resetMindSection(input);
              await refreshMindSnapshot();
              return result;
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
        </Suspense>
      );
    }

    if (activePage === "mcp") {
      return (
        <Suspense fallback={loading}>
          <McpPage config={config} setConfig={setConfig} />
        </Suspense>
      );
    }

    return (
      <Suspense fallback={loading}>
        <SettingsPage config={config} status={status} setConfig={setConfig} />
      </Suspense>
    );
  }, [activePage, config, refreshStatus, status, mindSnapshot, refreshMindSnapshot]);

  const showPageHeader =
    activePage !== "console" && activePage !== "topics" && activePage !== "dashboard";

  return (
    <div className="mx-auto grid min-h-screen max-w-[1440px] gap-6 p-6 lg:grid-cols-[248px_1fr]">
      <SideNav active={activePage} onSelect={setActivePage} />

      <main className={showPageHeader ? "space-y-6" : undefined}>
        {showPageHeader ? (
          <section className="flex flex-wrap items-center justify-between gap-4 rounded-[32px] border border-white/60 bg-white/70 px-8 py-6 shadow-[0_24px_60px_rgba(53,38,21,0.08)] backdrop-blur">
            <div>
              <h1 className="font-display text-3xl tracking-tight text-foreground">
                {pageTitle(activePage)}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">{notice}</p>
            </div>

            <div className="flex items-center gap-3">
              <Badge className={status?.telegramConnected ? "border-emerald-300" : "border-amber-300"}>
                Telegram {status?.telegramConnected ? "Online" : "Offline"}
              </Badge>
              <Badge className={status?.qqConnected ? "border-emerald-300" : "border-amber-300"}>
                QQ {status?.qqConnected ? "Online" : "Offline"}
              </Badge>
              <Badge className={status?.feishuConnected ? "border-emerald-300" : "border-amber-300"}>
                Feishu {status?.feishuConnected ? "Online" : "Offline"}
              </Badge>
              {config ? (
                <Button onClick={saveConfig} disabled={saving}>
                  {saving ? "保存中..." : "保存配置"}
                </Button>
              ) : null}
            </div>
          </section>
        ) : null}

        {content}
      </main>
    </div>
  );
}
