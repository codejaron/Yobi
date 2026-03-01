import { useEffect, useState } from "react";
import type { AppConfig } from "@shared/types";
import { AlibabaVoiceCard } from "@renderer/pages/settings/AlibabaVoiceCard";
import { EdgeTtsCard } from "@renderer/pages/settings/EdgeTtsCard";
import {
  DEFAULT_PTT_HOTKEY,
  formatHotkeyText,
  hotkeyFromKeyboardEvent,
  normalizeHotkeyString
} from "@renderer/pages/settings/hotkey-utils";
import { MemorySettingsCard } from "@renderer/pages/settings/MemorySettingsCard";
import { MessagingCard } from "@renderer/pages/settings/MessagingCard";
import { OpenClawSettingsCard } from "@renderer/pages/settings/OpenClawSettingsCard";
import { PetRuntimeCard } from "@renderer/pages/settings/PetRuntimeCard";
import { ProactiveSettingsCard } from "@renderer/pages/settings/ProactiveSettingsCard";
import { TelegramChannelCard } from "@renderer/pages/settings/TelegramChannelCard";

export function SettingsPage({
  config,
  setConfig
}: {
  config: AppConfig;
  setConfig: (next: AppConfig) => void;
}) {
  const observationalProviderOptions = config.providers.map((provider) => ({
    id: provider.id,
    label: provider.enabled ? provider.label : `${provider.label}（已停用）`
  }));
  const clawProviderOptions = config.providers.map((provider) => ({
    id: provider.id,
    label: provider.enabled ? provider.label : `${provider.label}（已停用）`
  }));
  const clawPrimarySelection = (() => {
    const route = config.modelRouting.chat;
    const raw = config.openclaw.modelPrimary.trim();
    if (!raw) {
      return {
        followChat: true,
        providerId: route.providerId,
        modelId: route.model
      };
    }

    const slashIndex = raw.indexOf("/");
    if (slashIndex <= 0 || slashIndex >= raw.length - 1) {
      return {
        followChat: false,
        providerId: route.providerId,
        modelId: raw
      };
    }

    return {
      followChat: false,
      providerId: raw.slice(0, slashIndex),
      modelId: raw.slice(slashIndex + 1)
    };
  })();
  const clawFallbackInput = config.openclaw.modelFallbacks.join(", ");
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

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <TelegramChannelCard config={config} setConfig={setConfig} />

      <MessagingCard config={config} setConfig={setConfig} />

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

      <AlibabaVoiceCard config={config} setConfig={setConfig} />

      <EdgeTtsCard config={config} setConfig={setConfig} />

      <ProactiveSettingsCard config={config} setConfig={setConfig} />

      <MemorySettingsCard
        config={config}
        setConfig={setConfig}
        observationalProviderOptions={observationalProviderOptions}
      />

      <OpenClawSettingsCard
        config={config}
        setConfig={setConfig}
        clawProviderOptions={clawProviderOptions}
        clawPrimarySelection={clawPrimarySelection}
        clawFallbackInput={clawFallbackInput}
      />
    </div>
  );
}
