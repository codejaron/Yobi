import { BrowserWindow, dialog, ipcMain, shell, WebContents } from "electron";
import type { OpenDialogOptions } from "electron";
import type { AppConfig, CharacterProfile, CommandApprovalDecision } from "@shared/types";
import { runtime } from "./runtime";

const STATUS_CHANNEL = "runtime:status";
const CONSOLE_CHAT_EVENT_CHANNEL = "runtime:console-chat-event";
const statusSubscriptions = new Map<number, () => void>();
const consoleChatSubscriptions = new Map<number, () => void>();

export function registerIpcHandlers(): void {
  ipcMain.handle("config:get", () => runtime.getConfig());
  ipcMain.handle("config:save", (_, config: AppConfig) => runtime.saveConfig(config));

  ipcMain.handle("character:get", (_, characterId: string) => runtime.getCharacter(characterId));
  ipcMain.handle("character:save", (_, profile: CharacterProfile) =>
    runtime.saveCharacter(profile)
  );

  ipcMain.handle("history:list", (_, query: { query?: string; limit?: number; offset?: number }) =>
    runtime.getHistory(query)
  );
  ipcMain.handle("history:clear", () => runtime.clearHistory());

  ipcMain.handle("memory:list", () => runtime.getMemoryFacts());
  ipcMain.handle(
    "memory:upsert",
    (_, fact: { id?: string; content: string; confidence: number }) => runtime.upsertMemoryFact(fact)
  );
  ipcMain.handle("memory:delete", (_, id: string) => runtime.deleteMemoryFact(id));
  ipcMain.handle("memory:clear", () => runtime.clearMemoryFacts());
  ipcMain.handle("memory:open-location", () => {
    const path = runtime.getMemoryFilePath();
    shell.showItemInFolder(path);

    return {
      path
    };
  });

  ipcMain.handle("status:get", () => runtime.getStatus());
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
  ipcMain.handle("console:chat:send", (_, payload: { text?: string }) =>
    runtime.startConsoleChat(payload?.text ?? "")
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

  ipcMain.on("status:subscribe", (event) => {
    const target = event.sender;
    subscribeToStatus(target);
  });

  ipcMain.on("console:chat:subscribe", (event) => {
    const target = event.sender;
    subscribeToConsoleChat(target);
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

function subscribeToConsoleChat(target: WebContents): void {
  const previous = consoleChatSubscriptions.get(target.id);
  if (previous) {
    previous();
    consoleChatSubscriptions.delete(target.id);
  }

  const unsubscribe = runtime.onConsoleChatEvent((event) => {
    if (target.isDestroyed()) {
      unsubscribe();
      consoleChatSubscriptions.delete(target.id);
      return;
    }

    target.send(CONSOLE_CHAT_EVENT_CHANNEL, event);
  });
  consoleChatSubscriptions.set(target.id, unsubscribe);

  target.once("destroyed", () => {
    const active = consoleChatSubscriptions.get(target.id);
    if (active) {
      active();
      consoleChatSubscriptions.delete(target.id);
    }
  });
}
