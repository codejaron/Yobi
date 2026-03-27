import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppConfig,
  AppStatus,
  MindSnapshot,
  ThemeMode
} from "@shared/types";
import { SideNav } from "@renderer/components/layout/SideNav";
import { applyThemeMode, subscribeSystemTheme, writeCachedThemeMode } from "@renderer/lib/theme";
import type { PageId } from "./types";

const DashboardPage = lazy(async () => {
  const module = await import("@renderer/pages/Dashboard");
  return { default: module.DashboardPage };
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
const CognitionDebugPage = lazy(async () => {
  const module = await import("@renderer/pages/CognitionDebug");
  return { default: module.CognitionDebugPage };
});
const SettingsPage = lazy(async () => {
  const module = await import("@renderer/pages/Settings");
  return { default: module.SettingsPage };
});

function pageFromHash(hash: string): PageId | null {
  return hash === "#/dev/cognition" ? "cognition" : null;
}

function syncHashWithPage(pageId: PageId): void {
  if (typeof window === "undefined") {
    return;
  }

  const targetHash = pageId === "cognition" ? "#/dev/cognition" : "";
  if (window.location.hash === targetHash) {
    return;
  }

  const nextUrl = `${window.location.pathname}${window.location.search}${targetHash}`;
  window.history.replaceState(null, "", nextUrl);
}

function themeModeLabel(mode: ThemeMode): string {
  if (mode === "dark") {
    return "暗黑";
  }

  if (mode === "light") {
    return "浅色";
  }

  return "跟随系统";
}

function configFingerprint(config: AppConfig): string {
  return JSON.stringify(config);
}

export default function App() {
  const [activePage, setActivePage] = useState<PageId>(() => pageFromHash(window.location.hash) ?? "dashboard");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [committedConfig, setCommittedConfig] = useState<AppConfig | null>(null);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [mindSnapshot, setMindSnapshot] = useState<MindSnapshot | null>(null);
  const [autoSaving, setAutoSaving] = useState(false);
  const [notice, setNotice] = useState("启动中...");
  const latestConfigRef = useRef<AppConfig | null>(null);
  const latestCommittedConfigRef = useRef<AppConfig | null>(null);
  const saveInFlightRef = useRef(false);
  const pendingSaveRef = useRef(false);

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
    const onHashChange = () => {
      const nextPage = pageFromHash(window.location.hash);
      if (nextPage) {
        setActivePage(nextPage);
      }
    };

    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  useEffect(() => {
    syncHashWithPage(activePage);
  }, [activePage]);

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
        setCommittedConfig(nextConfig);
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
        setCommittedConfig((current) => {
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

  useEffect(() => {
    if (!config) {
      return;
    }

    const mode = config.appearance.themeMode;
    writeCachedThemeMode(mode);
    applyThemeMode(mode);

    if (mode !== "system") {
      return;
    }

    return subscribeSystemTheme((prefersDark) => {
      applyThemeMode("system", prefersDark);
    });
  }, [config?.appearance.themeMode]);

  useEffect(() => {
    latestConfigRef.current = config;
  }, [config]);

  useEffect(() => {
    latestCommittedConfigRef.current = committedConfig;
  }, [committedConfig]);

  const persistConfigChanges = useCallback(async () => {
    if (saveInFlightRef.current) {
      pendingSaveRef.current = true;
      return;
    }

    const draft = latestConfigRef.current;
    const committed = latestCommittedConfigRef.current;
    if (!draft || !committed) {
      return;
    }

    const draftFingerprint = configFingerprint(draft);
    if (draftFingerprint === configFingerprint(committed)) {
      return;
    }

    saveInFlightRef.current = true;
    setAutoSaving(true);

    try {
      const saved = await window.companion.saveConfig(draft);
      latestCommittedConfigRef.current = saved;
      setCommittedConfig(saved);
      writeCachedThemeMode(saved.appearance.themeMode);

      setConfig((current) => {
        if (!current) {
          return current;
        }

        return configFingerprint(current) === draftFingerprint ? saved : current;
      });

      setNotice(`已自动保存 (${new Date().toLocaleTimeString()})`);
      await refreshStatus();
    } catch (error) {
      setNotice(error instanceof Error ? `自动保存失败：${error.message}` : "自动保存失败");
    } finally {
      saveInFlightRef.current = false;
      setAutoSaving(false);

      if (pendingSaveRef.current) {
        pendingSaveRef.current = false;
        void persistConfigChanges();
      }
    }
  }, [refreshStatus]);

  const configFingerprintValue = useMemo(
    () => (config ? configFingerprint(config) : ""),
    [config]
  );
  const committedConfigFingerprintValue = useMemo(
    () => (committedConfig ? configFingerprint(committedConfig) : ""),
    [committedConfig]
  );

  useEffect(() => {
    if (!config || !committedConfig) {
      return;
    }

    if (configFingerprintValue === committedConfigFingerprintValue) {
      return;
    }

    const timer = window.setTimeout(() => {
      void persistConfigChanges();
    }, 800);

    return () => {
      window.clearTimeout(timer);
    };
  }, [committedConfig, committedConfigFingerprintValue, config, configFingerprintValue, persistConfigChanges]);

  const handleThemeModeChange = useCallback(
    (mode: ThemeMode) => {
      if (!config || config.appearance.themeMode === mode) {
        return;
      }

      const nextVisibleConfig: AppConfig = {
        ...config,
        appearance: {
          ...config.appearance,
          themeMode: mode
        }
      };

      setConfig(nextVisibleConfig);
      writeCachedThemeMode(mode);
      applyThemeMode(mode);
      setNotice(`主题已切换为${themeModeLabel(mode)}，正在自动保存...`);
    },
    [config]
  );

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
          <ConsoleChatPage config={config} setConfig={setConfig} />
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
            onRegenerateCognitionGraph={async () => {
              const result = await window.companion.regenerateCognitionGraphFromSoul();
              await refreshMindSnapshot();
              setNotice(result.message);
              return result;
            }}
            onSaveRelationship={async (guide) => {
              await window.companion.saveRelationship({ guide });
              await refreshMindSnapshot();
              setNotice("RELATIONSHIP 已更新");
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

    if (activePage === "cognition") {
      return (
        <Suspense fallback={loading}>
          <CognitionDebugPage />
        </Suspense>
      );
    }

    return (
      <Suspense fallback={loading}>
        <SettingsPage
          config={config}
          status={status}
          setConfig={setConfig}
          onNavigateToCognition={() => setActivePage("cognition")}
          themeSaving={autoSaving}
          onThemeModeChange={handleThemeModeChange}
        />
      </Suspense>
    );
  }, [activePage, autoSaving, config, handleThemeModeChange, refreshStatus, status, mindSnapshot, refreshMindSnapshot]);

  return (
    <div
      className={`grid h-screen min-h-0 grid-rows-[36px_minmax(0,1fr)] ${
        sidebarCollapsed ? "grid-cols-[60px_minmax(0,1fr)]" : "grid-cols-[248px_minmax(0,1fr)]"
      }`}
    >
      <div className="window-drag-region col-span-2 border-b border-border/70 bg-card/82 backdrop-blur-md" />

      <SideNav
        active={activePage}
        onSelect={setActivePage}
        themeMode={config?.appearance.themeMode ?? "system"}
        onThemeModeChange={handleThemeModeChange}
        themeSaving={autoSaving}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
      />

      <main className="min-h-0 min-w-0 overflow-hidden bg-card/72 backdrop-blur-md">
        <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1 overflow-auto p-5">
            {activePage === "settings" ? (
              <div className="mb-3 text-xs text-muted-foreground">{notice}</div>
            ) : null}
            {content}
          </div>
        </div>
      </main>
    </div>
  );
}
