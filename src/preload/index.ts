import { contextBridge, ipcRenderer } from "electron";
import type {
  AppConfig,
  AppStatus,
  CharacterProfile,
  ClawEvent,
  ClawHistoryItem,
  CommandApprovalDecision,
  ConsoleRunEventV2,
  HistoryMessage,
  KernelStateDocument,
  UserProfile
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
  getMindSnapshot() {
    return ipcRenderer.invoke("mind:snapshot:get");
  },
  getSoul() {
    return ipcRenderer.invoke("mind:soul:get");
  },
  saveSoul(input: { markdown: string }) {
    return ipcRenderer.invoke("mind:soul:save", input);
  },
  getPersona() {
    return ipcRenderer.invoke("mind:persona:get");
  },
  savePersona(input: { markdown: string }) {
    return ipcRenderer.invoke("mind:persona:save", input);
  },
  patchState(input: { patch: Partial<KernelStateDocument> }) {
    return ipcRenderer.invoke("mind:state:patch", input);
  },
  patchProfile(input: { patch: Partial<UserProfile> }) {
    return ipcRenderer.invoke("mind:profile:patch", input);
  },
  triggerKernelTask(taskType: "tick-now" | "daily-now") {
    return ipcRenderer.invoke("kernel:task:trigger", {
      taskType
    });
  },

  getStatus(): Promise<AppStatus> {
    return ipcRenderer.invoke("status:get");
  },
  startBilibiliQrAuth(): Promise<{
    authState: "missing" | "pending" | "active" | "expired" | "error";
    qrcodeKey: string;
    scanUrl: string;
    expiresAt: string;
  }> {
    return ipcRenderer.invoke("browse:bili:qr:start");
  },
  pollBilibiliQrAuth(input: { qrcodeKey: string }): Promise<{
    authState: "missing" | "pending" | "active" | "expired" | "error";
    status: "pending" | "scanned" | "confirmed" | "expired" | "error";
    detail: string;
    cookieSaved: boolean;
  }> {
    return ipcRenderer.invoke("browse:bili:qr:poll", input);
  },
  saveBilibiliCookie(input: { cookie: string }): Promise<{
    saved: boolean;
    message: string;
    authState: "missing" | "pending" | "active" | "expired" | "error";
  }> {
    return ipcRenderer.invoke("browse:bili:cookie:save", input);
  },
  triggerTopicRecall(): Promise<{ accepted: boolean; message: string }> {
    return ipcRenderer.invoke("topic:recall:trigger");
  },
  triggerTopicBrowse(): Promise<{ accepted: boolean; message: string }> {
    return ipcRenderer.invoke("topic:browse:trigger");
  },
  deleteTopicPoolItem(topicId: string): Promise<{ accepted: boolean; message: string }> {
    return ipcRenderer.invoke("topic-pool:item:delete", {
      topicId
    });
  },
  clearTopicPool(): Promise<{ accepted: boolean; message: string }> {
    return ipcRenderer.invoke("topic-pool:clear");
  },
  openSystemPermissionSettings(
    permission: "accessibility" | "microphone" | "screenCapture"
  ): Promise<{ opened: boolean; prompted: boolean }> {
    return ipcRenderer.invoke("system:permissions:open-settings", permission);
  },
  resetSystemPermissions(): Promise<{ reset: boolean; message?: string }> {
    return ipcRenderer.invoke("system:permissions:reset");
  },
  openOpenClawWebUi(): Promise<{ opened: boolean; message: string }> {
    return ipcRenderer.invoke("openclaw:webui:open");
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
  },
  clawConnect(): Promise<{ connected: boolean; message: string }> {
    return ipcRenderer.invoke("claw:connect");
  },
  clawDisconnect(): Promise<{ connected: boolean; message: string }> {
    return ipcRenderer.invoke("claw:disconnect");
  },
  clawSend(message: string): Promise<{ accepted: boolean; message: string }> {
    return ipcRenderer.invoke("claw:send", {
      message
    });
  },
  clawHistory(limit?: number): Promise<{ items: ClawHistoryItem[] }> {
    return ipcRenderer.invoke("claw:history", {
      limit
    });
  },
  clawAbort(): Promise<{ accepted: boolean; message: string }> {
    return ipcRenderer.invoke("claw:abort");
  },
  onClawEvent(listener: (event: ClawEvent) => void): () => void {
    const channel = "runtime:claw-event";
    const wrapped = (_event: Electron.IpcRendererEvent, payload: ClawEvent) => {
      listener(payload);
    };

    ipcRenderer.on(channel, wrapped);
    ipcRenderer.send("claw:subscribe");

    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  }
};

contextBridge.exposeInMainWorld("companion", api);
