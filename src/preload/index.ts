import { contextBridge, ipcRenderer } from "electron";
import type {
  AppConfig,
  AppStatus,
  CharacterProfile,
  CommandApprovalDecision,
  ConsoleRunEventV2,
  HistoryMessage,
  WorkingMemoryDocument
} from "@shared/types";
import type { CompanionApi } from "@shared/ipc";

const api: CompanionApi = {
  getConfig(): Promise<AppConfig> {
    return ipcRenderer.invoke("config:get");
  },
  saveConfig(config: AppConfig): Promise<AppConfig> {
    return ipcRenderer.invoke("config:save", config);
  },

  getCharacter(characterId: string): Promise<CharacterProfile> {
    return ipcRenderer.invoke("character:get", characterId);
  },
  saveCharacter(profile: CharacterProfile): Promise<void> {
    return ipcRenderer.invoke("character:save", profile);
  },

  listHistory(query?: { query?: string; limit?: number; offset?: number }): Promise<HistoryMessage[]> {
    return ipcRenderer.invoke("history:list", query ?? {});
  },
  clearHistory(): Promise<void> {
    return ipcRenderer.invoke("history:clear");
  },

  getWorkingMemory(): Promise<WorkingMemoryDocument> {
    return ipcRenderer.invoke("memory:get");
  },
  saveWorkingMemory(input: { markdown: string }): Promise<WorkingMemoryDocument> {
    return ipcRenderer.invoke("memory:save", input);
  },

  getStatus(): Promise<AppStatus> {
    return ipcRenderer.invoke("status:get");
  },
  openSystemPermissionSettings(
    permission: "accessibility" | "microphone" | "screenCapture"
  ): Promise<{ opened: boolean; prompted: boolean }> {
    return ipcRenderer.invoke("system:permissions:open-settings", permission);
  },
  resetSystemPermissions(): Promise<{ reset: boolean; message?: string }> {
    return ipcRenderer.invoke("system:permissions:reset");
  },
  importPetModelFromDialog(): Promise<{
    canceled: boolean;
    modelDir?: string;
  }> {
    return ipcRenderer.invoke("pet:model:import");
  },
  onStatus(listener: (status: AppStatus) => void): () => void {
    const channel = "runtime:status";
    const wrapped = (_event: Electron.IpcRendererEvent, status: AppStatus) => {
      listener(status);
    };

    ipcRenderer.on(channel, wrapped);
    ipcRenderer.send("status:subscribe");

    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
  onPetEnabledChange(listener: (enabled: boolean) => void): () => void {
    const channel = "runtime:pet-enabled";
    const wrapped = (_event: Electron.IpcRendererEvent, enabled: boolean) => {
      listener(Boolean(enabled));
    };

    ipcRenderer.on(channel, wrapped);

    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },

  sendConsoleChat(text: string): Promise<{ requestId: string }> {
    return ipcRenderer.invoke("console:chat:send", {
      text
    });
  },
  transcribeVoice(input: {
    pcm16Base64: string;
    sampleRate: number;
  }): Promise<{ text: string }> {
    return ipcRenderer.invoke("voice:transcribe", input);
  },
  listConsoleHistory(input?: {
    cursor?: string;
    limit?: number;
  }): Promise<{
    items: HistoryMessage[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    return ipcRenderer.invoke("console:chat:history", input ?? {});
  },
  approveConsoleCommand(input: {
    approvalId: string;
    decision: CommandApprovalDecision;
  }): Promise<{ accepted: boolean }> {
    return ipcRenderer.invoke("console:chat:approve", input);
  },
  onConsoleRunEvent(listener: (event: ConsoleRunEventV2) => void): () => void {
    const channel = "runtime:console-run-event";
    const wrapped = (_event: Electron.IpcRendererEvent, payload: ConsoleRunEventV2) => {
      listener(payload);
    };

    ipcRenderer.on(channel, wrapped);
    ipcRenderer.send("console:chat:subscribe");

    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  }
};

contextBridge.exposeInMainWorld("companion", api);
