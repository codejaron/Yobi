import { ipcMain, WebContents } from "electron";
import type { AppConfig, CharacterProfile } from "@shared/types";
import { runtime } from "./runtime";

const STATUS_CHANNEL = "runtime:status";

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

  ipcMain.on("status:subscribe", (event) => {
    const target = event.sender;
    subscribeToStatus(target);
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
