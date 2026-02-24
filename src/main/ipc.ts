import { ipcMain, WebContents } from "electron";
import type { AppConfig, CharacterProfile, CommandApprovalDecision } from "@shared/types";
import { runtime } from "./runtime";

const STATUS_CHANNEL = "runtime:status";
const CONSOLE_CHAT_EVENT_CHANNEL = "runtime:console-chat-event";

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

  ipcMain.handle("memory:list", () => runtime.getMemoryFacts());
  ipcMain.handle(
    "memory:upsert",
    (_, fact: { id?: string; content: string; confidence: number }) => runtime.upsertMemoryFact(fact)
  );
  ipcMain.handle("memory:delete", (_, id: string) => runtime.deleteMemoryFact(id));

  ipcMain.handle("status:get", () => runtime.getStatus());
  ipcMain.handle("pet:chat:send", (_, payload: { text?: string }) =>
    runtime.chatFromPet(payload?.text ?? "")
  );
  ipcMain.handle("console:chat:send", (_, payload: { text?: string }) =>
    runtime.startConsoleChat(payload?.text ?? "")
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
  const unsubscribe = runtime.onStatus((status) => {
    if (target.isDestroyed()) {
      unsubscribe();
      return;
    }

    target.send(STATUS_CHANNEL, status);
  });

  target.once("destroyed", () => {
    unsubscribe();
  });
}

function subscribeToConsoleChat(target: WebContents): void {
  const unsubscribe = runtime.onConsoleChatEvent((event) => {
    if (target.isDestroyed()) {
      unsubscribe();
      return;
    }

    target.send(CONSOLE_CHAT_EVENT_CHANNEL, event);
  });

  target.once("destroyed", () => {
    unsubscribe();
  });
}
