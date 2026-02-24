import { contextBridge, ipcRenderer } from "electron";
import type {
  AppConfig,
  AppStatus,
  CharacterProfile,
  CommandApprovalDecision,
  ConsoleChatEvent,
  HistoryMessage,
  MemoryFact
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

  listMemory(): Promise<MemoryFact[]> {
    return ipcRenderer.invoke("memory:list");
  },
  upsertMemory(input: { id?: string; content: string; confidence: number }): Promise<MemoryFact> {
    return ipcRenderer.invoke("memory:upsert", input);
  },
  deleteMemory(id: string): Promise<void> {
    return ipcRenderer.invoke("memory:delete", id);
  },

  getStatus(): Promise<AppStatus> {
    return ipcRenderer.invoke("status:get");
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

  sendConsoleChat(text: string): Promise<{ requestId: string }> {
    return ipcRenderer.invoke("console:chat:send", {
      text
    });
  },
  approveConsoleCommand(input: {
    approvalId: string;
    decision: CommandApprovalDecision;
  }): Promise<{ accepted: boolean }> {
    return ipcRenderer.invoke("console:chat:approve", input);
  },
  onConsoleChatEvent(listener: (event: ConsoleChatEvent) => void): () => void {
    const channel = "runtime:console-chat-event";
    const wrapped = (_event: Electron.IpcRendererEvent, payload: ConsoleChatEvent) => {
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
