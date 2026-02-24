import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AppConfig,
  AppStatus,
  CharacterProfile,
  HistoryMessage,
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
import { HistoryPage } from "@renderer/pages/History";
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
    case "history":
      return "永久历史";
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
  const [history, setHistory] = useState<HistoryMessage[]>([]);
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

  const refreshHistory = useCallback(async (query?: string): Promise<void> => {
    const rows = await window.companion.listHistory({
      query,
      limit: 400,
      offset: 0
    });
    setHistory(rows);
  }, []);

  useEffect(() => {
    let unsub: (() => void) | null = null;

    const load = async (): Promise<void> => {
      const [nextConfig, nextStatus, nextMemory] = await Promise.all([
        window.companion.getConfig(),
        window.companion.getStatus(),
        window.companion.listMemory()
      ]);

      setConfig(nextConfig);
      setStatus(nextStatus);
      setMemoryFacts(nextMemory);

      const [currentCharacter, initialHistory] = await Promise.all([
        window.companion.getCharacter(nextConfig.characterId),
        window.companion.listHistory({ limit: 100 })
      ]);

      setCharacter(currentCharacter);
      setHistory(initialHistory);
      setNotice("就绪");

      unsub = window.companion.onStatus((update) => {
        setStatus(update);
      });
    };

    void load();

    return () => {
      unsub?.();
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
        />
      );
    }

    if (activePage === "history") {
      return <HistoryPage items={history} onSearch={refreshHistory} />;
    }

    return <SettingsPage config={config} setConfig={setConfig} />;
  }, [activePage, character, config, history, memoryFacts, refreshHistory, refreshMemory, refreshStatus, status]);

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
