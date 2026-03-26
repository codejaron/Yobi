import type { MenuItemConstructorOptions } from "electron";
import type { AppConfig } from "@shared/types";

interface PetContextMenuActions {
  openConsole: () => void;
  disablePet: () => void;
  toggleCompanionMode: () => void;
  toggleFreeConversation: () => void;
  toggleSpeechReply: () => void;
}

export function buildPetContextMenuTemplate(
  config: AppConfig,
  actions: PetContextMenuActions,
  companionModeActive = false
): MenuItemConstructorOptions[] {
  const freeConversationEnabled = config.realtimeVoice.enabled && config.realtimeVoice.mode === "free";

  return [
    {
      label: "打开 Yobi 控制台",
      click: actions.openConsole
    },
    {
      type: "separator"
    },
    {
      label: "语音回复",
      type: "checkbox",
      checked: config.realtimeVoice.speechReplyEnabled,
      click: actions.toggleSpeechReply
    },
    {
      type: "separator"
    },
    {
      label: "陪伴模式",
      type: "checkbox",
      checked: companionModeActive,
      click: actions.toggleCompanionMode
    },
    {
      type: "separator"
    },
    {
      label: "自由对话",
      type: "checkbox",
      checked: freeConversationEnabled,
      click: actions.toggleFreeConversation
    },
    {
      type: "separator"
    },
    {
      label: "退出桌宠",
      click: actions.disablePet
    }
  ];
}
