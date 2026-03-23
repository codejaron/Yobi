import { useEffect, useMemo, useState } from "react";
import type { AppConfig, AppStatus, BrowseAuthState, EmbedderRuntimeStatus, ThemeMode } from "@shared/types";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@renderer/components/ui/card";
import { AppearanceSettingsCard } from "@renderer/pages/settings/AppearanceSettingsCard";
import { BilibiliBrowseCard } from "@renderer/pages/settings/BilibiliBrowseCard";
import { FeishuChannelCard } from "@renderer/pages/settings/FeishuChannelCard";
import {
  DEFAULT_PTT_HOTKEY,
  formatHotkeyText,
  hotkeyFromKeyboardEvent,
  normalizeHotkeyString
} from "@renderer/pages/settings/hotkey-utils";
import { MemorySettingsCard } from "@renderer/pages/settings/MemorySettingsCard";
import { PetRuntimeCard } from "@renderer/pages/settings/PetRuntimeCard";
import { ProactiveSettingsCard } from "@renderer/pages/settings/ProactiveSettingsCard";
import { QQChannelCard } from "@renderer/pages/settings/QQChannelCard";
import { TelegramChannelCard } from "@renderer/pages/settings/TelegramChannelCard";
import { ToolSettingsCard } from "@renderer/pages/settings/ToolSettingsCard";
import { VoiceEnginesCard } from "@renderer/pages/settings/VoiceEnginesCard";
import { formatEmbedderDisplay } from "@renderer/pages/settings/memory-display";

type SettingsSectionId =
  | "telegram"
  | "qq"
  | "feishu"
  | "appearance"
  | "voice"
  | "pet"
  | "bilibili"
  | "proactive"
  | "memory"
  | "tools";

type SectionTone = "good" | "warn" | "neutral" | "info";

type SectionSnapshot = {
  badge: string;
  tone: SectionTone;
  detail: string;
};

type SettingsSectionMeta = {
  id: SettingsSectionId;
  label: string;
  description: string;
};

type SettingsNavGroup = {
  label: string;
  sections: SettingsSectionMeta[];
};

const SETTINGS_STORAGE_KEY = "yobi.settings.active-section";

const SETTINGS_NAV_GROUPS: SettingsNavGroup[] = [
  {
    label: "通道",
    sections: [
      {
        id: "telegram",
        label: "Telegram",
        description: "Bot Token、Chat ID 与连接状态"
      },
      {
        id: "qq",
        label: "QQ",
        description: "私聊通道开关与应用凭证"
      },
      {
        id: "feishu",
        label: "飞书",
        description: "长连接通道与 App 凭证"
      }
    ]
  },
  {
    label: "交互",
    sections: [
      {
        id: "appearance",
        label: "外观",
        description: "浅色 / 暗黑 / 跟随系统"
      },
      {
        id: "voice",
        label: "语音",
        description: "ASR / TTS provider 与模型状态"
      },
      {
        id: "pet",
        label: "桌宠",
        description: "模型导入、置顶和 PTT 热键"
      }
    ]
  },
  {
    label: "行为",
    sections: [
      {
        id: "bilibili",
        label: "Bilibili 素材",
        description: "授权、同步与自动关注"
      },
      {
        id: "proactive",
        label: "主动行为",
        description: "主动表达开关、推送渠道与静默时段"
      }
    ]
  },
  {
    label: "认知与集成",
    sections: [
      {
        id: "memory",
        label: "Memory",
        description: "Embedding、上下文与记忆策略"
      },
      {
        id: "tools",
        label: "工具",
        description: "Exa 搜索、浏览器、系统与文件能力"
      }
    ]
  }
];

const SETTINGS_SECTION_ORDER = SETTINGS_NAV_GROUPS.flatMap((group) => group.sections.map((section) => section.id));

function isSettingsSectionId(value: string | null): value is SettingsSectionId {
  return value !== null && SETTINGS_SECTION_ORDER.includes(value as SettingsSectionId);
}

function toneClassName(tone: SectionTone): string {
  if (tone === "good") {
    return "status-badge status-badge--success";
  }

  if (tone === "warn") {
    return "status-badge status-badge--warn";
  }

  if (tone === "info") {
    return "status-badge status-badge--info";
  }

  return "status-badge status-badge--neutral";
}

function themeModeDetail(themeMode: ThemeMode): string {
  if (themeMode === "dark") {
    return "固定暗黑模式";
  }

  if (themeMode === "light") {
    return "固定浅色模式";
  }

  return "自动跟随系统深浅色";
}

function providerLabel(provider: AppConfig["voice"]["asrProvider"] | AppConfig["voice"]["ttsProvider"]): string {
  if (provider === "sensevoice-local") {
    return "SenseVoice";
  }

  if (provider === "alibaba") {
    return "阿里";
  }

  if (provider === "edge") {
    return "Edge";
  }

  return "无";
}

function authStateLabel(authState: BrowseAuthState): string {
  if (authState === "active") {
    return "已授权";
  }

  if (authState === "pending") {
    return "等待授权";
  }

  if (authState === "expired") {
    return "已过期";
  }

  if (authState === "error") {
    return "异常";
  }

  return "未授权";
}

function embedderLabel(embedder: EmbedderRuntimeStatus): { badge: string; tone: SectionTone } {
  if (embedder.status === "ready" && (embedder.mode === "bm25-only" || embedder.mode === "vector-only")) {
    return {
      badge: "回退模式",
      tone: "warn"
    };
  }

  if (embedder.status === "ready") {
    return {
      badge: "已就绪",
      tone: "good"
    };
  }

  if (embedder.status === "loading") {
    return {
      badge: "加载中",
      tone: "info"
    };
  }

  if (embedder.status === "error") {
    return {
      badge: "异常",
      tone: "warn"
    };
  }

  return {
    badge: "已关闭",
    tone: "neutral"
  };
}

function buildSectionSnapshots(config: AppConfig, status: AppStatus | null): Record<SettingsSectionId, SectionSnapshot> {
  const telegramEnabled = config.telegram.enabled;
  const qqEnabled = config.qq.enabled;
  const feishuEnabled = config.feishu.enabled;
  const petEnabled = config.pet.enabled;
  const browseEnabled = config.browse.enabled;
  const proactiveEnabled = config.proactive.enabled;
  const embedderState = status?.embedder ?? {
    status: config.memory.embedding.enabled ? "loading" : "disabled",
    mode: config.memory.embedding.enabled ? "bm25-only" : "disabled",
    downloadPending: false,
    message: ""
  };

  return {
    appearance: {
      badge: config.appearance.themeMode === "system" ? "跟随系统" : config.appearance.themeMode === "dark" ? "暗黑" : "浅色",
      tone: config.appearance.themeMode === "system" ? "info" : "neutral",
      detail: themeModeDetail(config.appearance.themeMode)
    },
    telegram: telegramEnabled
      ? {
          badge: status?.telegramConnected ? "在线" : "待连接",
          tone: status?.telegramConnected ? "good" : "warn",
          detail: telegramEnabled ? "Bot 已启用，等待或保持连接" : "未启用"
        }
      : {
          badge: "关闭",
          tone: "neutral",
          detail: "未启用 Telegram 通道"
        },
    qq: qqEnabled
      ? {
          badge: status?.qqConnected ? "在线" : "待连接",
          tone: status?.qqConnected ? "good" : "warn",
          detail: "QQ 私聊通道已启用"
        }
      : {
          badge: "关闭",
          tone: "neutral",
          detail: "未启用 QQ 通道"
        },
    feishu: feishuEnabled
      ? {
          badge: status?.feishuConnected ? "在线" : "待连接",
          tone: status?.feishuConnected ? "good" : "warn",
          detail: "飞书长连接通道已启用"
        }
      : {
          badge: "关闭",
          tone: "neutral",
          detail: "未启用飞书通道"
        },
    voice: {
      badge: config.voice.asrProvider === "none" ? "部分关闭" : "已配置",
      tone: config.voice.asrProvider === "none" ? "warn" : "good",
      detail: `ASR ${providerLabel(config.voice.asrProvider)} · TTS ${providerLabel(config.voice.ttsProvider)}`
    },
    pet: petEnabled
      ? {
          badge: status?.petOnline ? "运行中" : "待启动",
          tone: status?.petOnline ? "good" : "warn",
          detail: config.pet.modelDir.trim() ? "桌宠已启用，模型已指定" : "桌宠已启用，但还未导入模型"
        }
      : {
          badge: "关闭",
          tone: "neutral",
          detail: "未启用桌宠"
        },
    bilibili: browseEnabled
      ? {
          badge: authStateLabel(status?.browseStatus.authState ?? "missing"),
          tone: status?.browseStatus.authState === "active" ? "good" : "warn",
          detail: status?.browseStatus.pausedReason
            ? `当前暂停：${status.browseStatus.pausedReason}`
            : status?.browseStatus.lastSyncAt
              ? `最近同步：${new Date(status.browseStatus.lastSyncAt).toLocaleString()}`
              : "素材同步器已启用，等待首次同步"
        }
      : {
          badge: "关闭",
          tone: "neutral",
          detail: "未启用 Bilibili 素材同步"
        },
    proactive: proactiveEnabled
      ? {
          badge: "已启用",
          tone: "good",
          detail: "认知主动表达允许外发"
        }
      : {
          badge: "关闭",
          tone: "neutral",
          detail: "未启用主动行为"
        },
    memory: {
      badge: embedderLabel(embedderState).badge,
      tone: embedderLabel(embedderState).tone,
      detail: config.memory.embedding.enabled
        ? formatEmbedderDisplay(status?.embedder).statusLabel === "回退模式"
          ? formatEmbedderDisplay(status?.embedder).engineLabel
          : "Hybrid 检索已启用"
        : "向量记忆已关闭"
    },
    tools: {
      badge:
        config.tools.browser.enabled ||
        config.tools.system.enabled ||
        config.tools.file.writeEnabled ||
        config.tools.exa.enabled
          ? "已配置"
          : "关闭",
      tone:
        config.tools.exa.enabled || config.tools.browser.enabled || config.tools.system.enabled
          ? "good"
          : "neutral",
      detail: `Exa ${config.tools.exa.enabled ? "开启" : "关闭"} · 浏览器 ${config.tools.browser.enabled ? "开启" : "关闭"} · 系统 ${config.tools.system.enabled ? "开启" : "关闭"}`
    }
  };
}

export function SettingsPage({
  config,
  status,
  setConfig,
  onNavigateToCognition,
  onThemeModeChange,
  themeSaving
}: {
  config: AppConfig;
  status: AppStatus | null;
  setConfig: (next: AppConfig) => void;
  onNavigateToCognition: () => void;
  onThemeModeChange: (mode: ThemeMode) => void;
  themeSaving: boolean;
}) {
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const [importingModel, setImportingModel] = useState(false);
  const [modelImportNotice, setModelImportNotice] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [isRecordingPttHotkey, setIsRecordingPttHotkey] = useState(false);
  const [pttHotkeyNotice, setPttHotkeyNotice] = useState("");
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(() => {
    if (typeof window === "undefined") {
      return "voice";
    }

    try {
      const saved = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
      return isSettingsSectionId(saved) ? saved : "voice";
    } catch {
      return "voice";
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, activeSection);
    } catch {}
  }, [activeSection]);

  useEffect(() => {
    if (!isRecordingPttHotkey) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setIsRecordingPttHotkey(false);
        setPttHotkeyNotice("已取消快捷键录制。");
        return;
      }

      const captured = hotkeyFromKeyboardEvent(event);
      if (captured.error) {
        setPttHotkeyNotice(captured.error);
        return;
      }

      if (!captured.hotkey) {
        return;
      }

      const normalized = normalizeHotkeyString(captured.hotkey) || DEFAULT_PTT_HOTKEY;
      setConfig({
        ...config,
        ptt: {
          ...config.ptt,
          hotkey: normalized
        }
      });
      setPttHotkeyNotice(`已设置为 ${formatHotkeyText(normalized, isMac)}。`);
      setIsRecordingPttHotkey(false);
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [config, isMac, isRecordingPttHotkey, setConfig]);

  const importModelDirectory = async (): Promise<void> => {
    if (importingModel) {
      return;
    }

    setImportingModel(true);
    setModelImportNotice(null);
    try {
      const result = await window.companion.importPetModelFromDialog();
      if (result.canceled || !result.modelDir) {
        return;
      }

      const nextConfig: AppConfig = {
        ...config,
        pet: {
          ...config.pet,
          enabled: true,
          modelDir: result.modelDir
        }
      };
      const saved = await window.companion.saveConfig(nextConfig);
      setConfig(saved);
      setModelImportNotice({
        type: "success",
        message: "模型导入成功，桌宠已自动切换到新模型。"
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "模型导入失败，请稍后重试。";
      setModelImportNotice({
        type: "error",
        message
      });
    } finally {
      setImportingModel(false);
    }
  };

  const toggleRecordPttHotkey = (): void => {
    if (isRecordingPttHotkey) {
      setIsRecordingPttHotkey(false);
      setPttHotkeyNotice("已取消快捷键录制。");
      return;
    }

    setPttHotkeyNotice(
      isMac
        ? "请按下快捷键组合，例如 Option+Space。按 Esc 取消。"
        : "请按下快捷键组合，例如 Alt+Space。按 Esc 取消。"
    );
    setIsRecordingPttHotkey(true);
  };

  const resetPttHotkey = (): void => {
    const normalized = DEFAULT_PTT_HOTKEY;
    setConfig({
      ...config,
      ptt: {
        ...config.ptt,
        hotkey: normalized
      }
    });
    setPttHotkeyNotice(`已恢复默认：${formatHotkeyText(normalized, isMac)}。`);
    setIsRecordingPttHotkey(false);
  };

  const sectionSnapshots = useMemo(() => buildSectionSnapshots(config, status), [config, status]);

  const activeMeta = useMemo(
    () => SETTINGS_NAV_GROUPS.flatMap((group) => group.sections).find((section) => section.id === activeSection),
    [activeSection]
  );

  const activeSnapshot = sectionSnapshots[activeSection];

  const detailPanel = (() => {
    switch (activeSection) {
      case "telegram":
        return <TelegramChannelCard config={config} setConfig={setConfig} />;
      case "qq":
        return <QQChannelCard config={config} setConfig={setConfig} />;
      case "feishu":
        return <FeishuChannelCard config={config} setConfig={setConfig} />;
      case "appearance":
        return (
          <AppearanceSettingsCard
            themeMode={config.appearance.themeMode}
            onThemeModeChange={onThemeModeChange}
            themeSaving={themeSaving}
          />
        );
      case "voice":
        return <VoiceEnginesCard config={config} setConfig={setConfig} />;
      case "pet":
        return (
          <PetRuntimeCard
            config={config}
            setConfig={setConfig}
            importModelDirectory={importModelDirectory}
            importingModel={importingModel}
            modelImportNotice={modelImportNotice}
            isMac={isMac}
            isRecordingPttHotkey={isRecordingPttHotkey}
            pttHotkeyNotice={pttHotkeyNotice}
            onToggleRecordHotkey={toggleRecordPttHotkey}
            onResetHotkey={resetPttHotkey}
          />
        );
      case "bilibili":
        return <BilibiliBrowseCard config={config} status={status} setConfig={setConfig} />;
      case "proactive":
        return <ProactiveSettingsCard config={config} setConfig={setConfig} />;
      case "memory":
        return <MemorySettingsCard config={config} status={status} setConfig={setConfig} />;
      case "tools":
        return <ToolSettingsCard config={config} setConfig={setConfig} />;
      default:
        return null;
    }
  })();

  return (
    <div className="grid gap-6 xl:grid-cols-[300px_minmax(0,1fr)] xl:items-start">
      <aside className="xl:sticky xl:top-6 xl:self-start">
        <Card className="border-white/60 bg-white/70 shadow-[0_24px_60px_rgba(53,38,21,0.08)] backdrop-blur">
          <CardHeader>
            <CardTitle>设置导航</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {SETTINGS_NAV_GROUPS.map((group) => (
              <div key={group.label} className="space-y-2">
                <div className="px-1 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground/80">
                  {group.label}
                </div>
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                  {group.sections.map((section) => {
                    const snapshot = sectionSnapshots[section.id];
                    const active = section.id === activeSection;
                    return (
                      <button
                        key={section.id}
                        type="button"
                        onClick={() => setActiveSection(section.id)}
                        className={`rounded-2xl border px-4 py-3 text-left transition-all ${
                          active
                            ? "border-primary/30 bg-primary/10 shadow-[0_12px_30px_rgba(38,106,129,0.12)]"
                            : "surface-panel hover:bg-card/90"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-foreground">{section.label}</div>
                            <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                              {snapshot.detail}
                            </div>
                          </div>
                          <Badge className={`${toneClassName(snapshot.tone)} shrink-0 whitespace-nowrap`}>
                            {snapshot.badge}
                          </Badge>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </aside>

      <section className="space-y-4">
        <Card className="border-white/60 bg-white/70 shadow-[0_24px_60px_rgba(53,38,21,0.08)] backdrop-blur">
          <CardContent className="flex flex-col gap-4 px-6 py-6 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="text-sm font-medium uppercase tracking-[0.22em] text-muted-foreground/75">
                {SETTINGS_NAV_GROUPS.find((group) => group.sections.some((section) => section.id === activeSection))?.label}
              </div>
              <h2 className="mt-2 text-3xl font-display tracking-tight text-foreground">
                {activeMeta?.label}
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                {activeMeta?.description}
              </p>
              <p className="mt-3 text-sm text-foreground/80">{activeSnapshot.detail}</p>
            </div>
            <Badge className={`${toneClassName(activeSnapshot.tone)} shrink-0 whitespace-nowrap`}>
              {activeSnapshot.badge}
            </Badge>
            <Button type="button" variant="outline" onClick={onNavigateToCognition}>
              开发者：认知调试面板
            </Button>
          </CardContent>
        </Card>

        {detailPanel}
      </section>
    </div>
  );
}
