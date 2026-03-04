import { BrowserWindow, dialog, ipcMain, shell, WebContents } from "electron";
import type { OpenDialogOptions } from "electron";
import type {
  AppConfig,
  CharacterProfile,
  ClawEvent,
  CommandApprovalDecision
} from "@shared/types";
import { runtime } from "./app-runtime";

const STATUS_CHANNEL = "runtime:status";
const CONSOLE_RUN_EVENT_CHANNEL = "runtime:console-run-event";
const CLAW_EVENT_CHANNEL = "runtime:claw-event";

interface IpcSubscription {
  unsubscribe: () => void;
  onDestroyed: () => void;
}

const statusSubscriptions = new Map<number, IpcSubscription>();
const consoleRunSubscriptions = new Map<number, IpcSubscription>();
const clawEventSubscriptions = new Map<number, IpcSubscription>();

function clearSubscription(target: WebContents, subscriptions: Map<number, IpcSubscription>): void {
  const current = subscriptions.get(target.id);
  if (!current) {
    return;
  }

  target.removeListener("destroyed", current.onDestroyed);
  current.unsubscribe();
  subscriptions.delete(target.id);
}

export function registerIpcHandlers(): void {
  ipcMain.handle("config:get", () => runtime.getConfig());
  ipcMain.handle("config:save", (_, config: AppConfig) => runtime.saveConfig(config));

  ipcMain.handle("character:get", (_, characterId: string) => runtime.getCharacter(characterId));
  ipcMain.handle("character:save", (_, profile: CharacterProfile) => runtime.saveCharacter(profile));

  ipcMain.handle("history:list", (_, query: { query?: string; limit?: number; offset?: number }) =>
    runtime.getHistory(query)
  );
  ipcMain.handle("history:clear", () => runtime.clearHistory());

  ipcMain.handle("mind:snapshot:get", () => runtime.getMindSnapshot());
  ipcMain.handle("mind:soul:get", () => runtime.getSoul());
  ipcMain.handle("mind:soul:save", (_, input: { markdown: string }) => runtime.saveSoul(input));
  ipcMain.handle("mind:persona:get", () => runtime.getPersona());
  ipcMain.handle("mind:persona:save", (_, input: { markdown: string }) => runtime.savePersona(input));
  ipcMain.handle("mind:state:patch", (_, input: { patch: Record<string, unknown> }) =>
    runtime.patchState({
      patch: input.patch as any
    })
  );
  ipcMain.handle("mind:profile:patch", (_, input: { patch: Record<string, unknown> }) =>
    runtime.patchProfile({
      patch: input.patch as any
    })
  );
  ipcMain.handle("kernel:task:trigger", (_, input: { taskType?: "tick-now" | "daily-now" }) =>
    runtime.triggerKernelTask(input?.taskType === "daily-now" ? "daily-now" : "tick-now")
  );

  ipcMain.handle("status:get", () => runtime.getStatus());
  ipcMain.handle("browse:bili:qr:start", () => runtime.startBilibiliQrAuth());
  ipcMain.handle("browse:bili:qr:poll", (_, payload: { qrcodeKey?: string }) =>
    runtime.pollBilibiliQrAuth({
      qrcodeKey: payload?.qrcodeKey ?? ""
    })
  );
  ipcMain.handle("browse:bili:cookie:save", (_, payload: { cookie?: string }) =>
    runtime.saveBilibiliCookie({
      cookie: payload?.cookie ?? ""
    })
  );
  ipcMain.handle("topic:recall:trigger", () => runtime.triggerTopicRecall());
  ipcMain.handle("topic:browse:trigger", () => runtime.triggerTopicBrowse());
  ipcMain.handle("topic-pool:item:delete", (_, payload: { topicId?: string }) =>
    runtime.deleteTopicPoolItem(payload?.topicId ?? "")
  );
  ipcMain.handle("topic-pool:clear", () => runtime.clearTopicPool());
  ipcMain.handle(
    "system:permissions:open-settings",
    (
      _,
      permission: "accessibility" | "microphone" | "screenCapture"
    ) => runtime.openSystemPermissionSettings(permission)
  );
  ipcMain.handle("system:permissions:reset", () => runtime.resetSystemPermissions());
  ipcMain.handle("openclaw:webui:open", () => runtime.openOpenClawWebUi());

  ipcMain.handle("pet:model:import", async (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: OpenDialogOptions = {
      title: "选择 Live2D 模型文件夹",
      properties: ["openDirectory"]
    };
    const picked = senderWindow
      ? await dialog.showOpenDialog(senderWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    if (picked.canceled || picked.filePaths.length === 0) {
      return {
        canceled: true
      };
    }

    const imported = await runtime.importPetModelDirectory(picked.filePaths[0]);
    return {
      canceled: false,
      modelDir: imported.modelDir
    };
  });

  ipcMain.handle("pet:chat:send", (_, payload: { text?: string }) =>
    runtime.chatFromPet(payload?.text ?? "")
  );
  ipcMain.handle(
    "pet:voice:transcribe-and-send",
    (
      _,
      payload: {
        pcm16Base64?: string;
        sampleRate?: number;
      }
    ) => runtime.transcribeAndSendFromPet(payload)
  );

  ipcMain.handle("console:chat:send", (_, payload: { text?: string }) =>
    runtime.startConsoleChat(payload?.text ?? "")
  );
  ipcMain.handle(
    "voice:transcribe",
    (
      _,
      payload: {
        pcm16Base64?: string;
        sampleRate?: number;
      }
    ) => runtime.transcribeVoiceInput(payload)
  );
  ipcMain.handle(
    "console:chat:history",
    (
      _,
      payload: {
        cursor?: string;
        limit?: number;
      }
    ) => runtime.getConsoleChatHistory(payload)
  );
  ipcMain.handle(
    "console:chat:approve",
    (
      _,
      payload: {
        approvalId: string;
        decision: CommandApprovalDecision;
      }
    ) => runtime.resolveConsoleApproval(payload)
  );

  ipcMain.handle("claw:connect", () => runtime.clawConnect());
  ipcMain.handle("claw:disconnect", () => runtime.clawDisconnect());
  ipcMain.handle("claw:send", (_, payload: { message?: string }) =>
    runtime.clawSend(payload?.message ?? "")
  );
  ipcMain.handle("claw:history", (_, payload: { limit?: number }) =>
    runtime.clawHistory(payload?.limit ?? 50)
  );
  ipcMain.handle("claw:abort", () => runtime.clawAbort());

  ipcMain.on("status:subscribe", (event) => {
    subscribeToStatus(event.sender);
  });

  ipcMain.on("console:chat:subscribe", (event) => {
    subscribeToConsoleRun(event.sender);
  });

  ipcMain.on("claw:subscribe", (event) => {
    subscribeToClawEvents(event.sender);
  });

  ipcMain.handle("open:path", (_, location: string) => {
    shell.showItemInFolder(location);
    return {
      path: location
    };
  });
}

function subscribeToStatus(target: WebContents): void {
  clearSubscription(target, statusSubscriptions);

  const unsubscribe = runtime.onStatus((status) => {
    if (target.isDestroyed()) {
      clearSubscription(target, statusSubscriptions);
      return;
    }

    target.send(STATUS_CHANNEL, status);
  });

  const onDestroyed = () => {
    clearSubscription(target, statusSubscriptions);
  };

  statusSubscriptions.set(target.id, {
    unsubscribe,
    onDestroyed
  });
  target.on("destroyed", onDestroyed);
}

function subscribeToConsoleRun(target: WebContents): void {
  clearSubscription(target, consoleRunSubscriptions);

  const unsubscribe = runtime.onConsoleRunEvent((event) => {
    if (target.isDestroyed()) {
      clearSubscription(target, consoleRunSubscriptions);
      return;
    }

    target.send(CONSOLE_RUN_EVENT_CHANNEL, event);
  });

  const onDestroyed = () => {
    clearSubscription(target, consoleRunSubscriptions);
  };

  consoleRunSubscriptions.set(target.id, {
    unsubscribe,
    onDestroyed
  });
  target.on("destroyed", onDestroyed);
}

function subscribeToClawEvents(target: WebContents): void {
  clearSubscription(target, clawEventSubscriptions);

  const unsubscribe = runtime.onClawEvent((event: ClawEvent) => {
    if (target.isDestroyed()) {
      clearSubscription(target, clawEventSubscriptions);
      return;
    }

    target.send(CLAW_EVENT_CHANNEL, event);
  });

  const onDestroyed = () => {
    clearSubscription(target, clawEventSubscriptions);
  };

  clawEventSubscriptions.set(target.id, {
    unsubscribe,
    onDestroyed
  });
  target.on("destroyed", onDestroyed);

  if (!target.isDestroyed()) {
    target.send(CLAW_EVENT_CHANNEL, runtime.getClawConnectionEvent());
    target.send(CLAW_EVENT_CHANNEL, runtime.getClawTaskMonitorEvent());
  }
}
