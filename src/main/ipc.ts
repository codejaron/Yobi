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
const statusSubscriptions = new Map<number, () => void>();
const consoleRunSubscriptions = new Map<number, () => void>();
const clawEventSubscriptions = new Map<number, () => void>();

export function registerIpcHandlers(): void {
  ipcMain.handle("config:get", () => runtime.getConfig());
  ipcMain.handle("config:save", (_, config: AppConfig) => runtime.saveConfig(config));

  ipcMain.handle("character:get", (_, characterId: string) => runtime.getCharacter(characterId));
  ipcMain.handle("character:save", (_, profile: CharacterProfile) => runtime.saveCharacter(profile));

  ipcMain.handle("history:list", (_, query: { query?: string; limit?: number; offset?: number }) =>
    runtime.getHistory(query)
  );
  ipcMain.handle("history:clear", () => runtime.clearHistory());

  ipcMain.handle("memory:get", () => runtime.getWorkingMemory());
  ipcMain.handle("memory:save", (_, input: { markdown: string }) => runtime.saveWorkingMemory(input));

  ipcMain.handle("status:get", () => runtime.getStatus());
  ipcMain.handle(
    "system:permissions:open-settings",
    (
      _,
      permission: "accessibility" | "microphone" | "screenCapture"
    ) => runtime.openSystemPermissionSettings(permission)
  );
  ipcMain.handle("system:permissions:reset", () => runtime.resetSystemPermissions());

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
  const previous = statusSubscriptions.get(target.id);
  if (previous) {
    previous();
    statusSubscriptions.delete(target.id);
  }

  const unsubscribe = runtime.onStatus((status) => {
    if (target.isDestroyed()) {
      unsubscribe();
      statusSubscriptions.delete(target.id);
      return;
    }

    target.send(STATUS_CHANNEL, status);
  });
  statusSubscriptions.set(target.id, unsubscribe);

  target.once("destroyed", () => {
    const active = statusSubscriptions.get(target.id);
    if (active) {
      active();
      statusSubscriptions.delete(target.id);
    }
  });
}

function subscribeToConsoleRun(target: WebContents): void {
  const previous = consoleRunSubscriptions.get(target.id);
  if (previous) {
    previous();
    consoleRunSubscriptions.delete(target.id);
  }

  const unsubscribe = runtime.onConsoleRunEvent((event) => {
    if (target.isDestroyed()) {
      unsubscribe();
      consoleRunSubscriptions.delete(target.id);
      return;
    }

    target.send(CONSOLE_RUN_EVENT_CHANNEL, event);
  });
  consoleRunSubscriptions.set(target.id, unsubscribe);

  target.once("destroyed", () => {
    const active = consoleRunSubscriptions.get(target.id);
    if (active) {
      active();
      consoleRunSubscriptions.delete(target.id);
    }
  });
}

function subscribeToClawEvents(target: WebContents): void {
  const previous = clawEventSubscriptions.get(target.id);
  if (previous) {
    previous();
    clawEventSubscriptions.delete(target.id);
  }

  const unsubscribe = runtime.onClawEvent((event: ClawEvent) => {
    if (target.isDestroyed()) {
      unsubscribe();
      clawEventSubscriptions.delete(target.id);
      return;
    }

    target.send(CLAW_EVENT_CHANNEL, event);
  });
  clawEventSubscriptions.set(target.id, unsubscribe);

  target.once("destroyed", () => {
    const active = clawEventSubscriptions.get(target.id);
    if (active) {
      active();
      clawEventSubscriptions.delete(target.id);
    }
  });
}
