import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AppConfig,
  AppStatus,
  CharacterProfile,
  MemoryFact
} from "@shared/types";
import { SideNav } from "@renderer/components/layout/SideNav";
import { Button } from "@renderer/components/ui/button";
import { Badge } from "@renderer/components/ui/badge";
import { DashboardPage } from "@renderer/pages/Dashboard";
import { ConsoleChatPage } from "@renderer/pages/ConsoleChat";
import { ProvidersPage } from "@renderer/pages/Providers";
import { CharacterPage } from "@renderer/pages/Character";
import { MemoryPage } from "@renderer/pages/Memory";
import { SettingsPage } from "@renderer/pages/Settings";
import type { PageId } from "./types";

function pageTitle(page: PageId): string {
  switch (page) {
    case "dashboard":
      return "运行仪表盘";
    case "providers":
      return "Provider 与模型路由";
    case "console":
      return "聊天控制台";
    case "character":
      return "角色人设";
    case "memory":
      return "长期记忆";
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
  const [character, setCharacter] = useState<CharacterProfile | null>(null);
  const [memoryFacts, setMemoryFacts] = useState<MemoryFact[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("启动中...");

  const refreshStatus = useCallback(async (): Promise<void> => {
    const next = await window.companion.getStatus();
    setStatus(next);
  }, []);

  const refreshMemory = useCallback(async (): Promise<void> => {
    const list = await window.companion.listMemory();
    setMemoryFacts(list);
  }, []);

  useEffect(() => {
    let unsubStatus: (() => void) | null = null;
    let unsubPetEnabled: (() => void) | null = null;

    const load = async (): Promise<void> => {
      const [nextConfig, nextStatus, nextMemory] = await Promise.all([
        window.companion.getConfig(),
        window.companion.getStatus(),
        window.companion.listMemory()
      ]);

      setConfig(nextConfig);
      setStatus(nextStatus);
      setMemoryFacts(nextMemory);

      const currentCharacter = await window.companion.getCharacter(nextConfig.characterId);

      setCharacter(currentCharacter);
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

  const saveConfig = useCallback(async () => {
    if (!config) {
      return;
    }

    setSaving(true);
    try {
      const saved = await window.companion.saveConfig(config);
      setConfig(saved);
      if (character && character.id !== saved.characterId) {
        const profile = await window.companion.getCharacter(saved.characterId);
        setCharacter(profile);
      }
      setNotice(`已保存 (${new Date().toLocaleTimeString()})`);
      await refreshStatus();
    } finally {
      setSaving(false);
    }
  }, [character, config, refreshStatus]);

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

    if (activePage === "providers") {
      return <ProvidersPage config={config} setConfig={setConfig} />;
    }

    if (activePage === "character") {
      return (
        <CharacterPage
          profile={character}
          onSave={async (profile) => {
            await window.companion.saveCharacter(profile);
            setCharacter(profile);
            if (config.characterId !== profile.id) {
              setConfig({
                ...config,
                characterId: profile.id
              });
            }
            setNotice(`角色已保存 (${new Date().toLocaleTimeString()})`);
          }}
        />
      );
    }

    if (activePage === "memory") {
      return (
        <MemoryPage
          facts={memoryFacts}
          onUpsert={async (input) => {
            await window.companion.upsertMemory(input);
            await refreshMemory();
            setNotice("记忆已更新");
          }}
          onDelete={async (id) => {
            await window.companion.deleteMemory(id);
            await refreshMemory();
            setNotice("记忆已删除");
          }}
          onClearAll={async () => {
            await window.companion.clearMemory();
            await refreshMemory();
            setNotice("长期记忆已清空");
          }}
          onOpenFileLocation={async () => {
            await window.companion.openMemoryFileLocation();
            setNotice("已打开记忆文件位置");
          }}
        />
      );
    }

    return <SettingsPage config={config} setConfig={setConfig} />;
  }, [activePage, character, config, memoryFacts, refreshMemory, refreshStatus, status]);

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
