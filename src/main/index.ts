import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, Menu } from "electron";
import { registerIpcHandlers } from "./ipc";
import { createRuntime } from "./app-runtime";
import { openSafeWebUrl } from "./utils/external-links";
import { appLogger as logger } from "@main/runtime/singletons";
import { buildPetContextMenuTemplate } from "@main/pet/context-menu";
import { getMainWindowOptions } from "@main/window-options";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PET_ENABLED_CHANNEL = "runtime:pet-enabled";
const runtime = createRuntime();

let mainWindow: BrowserWindow | null = null;
let shutdownRequested = false;
let shutdownPromise: Promise<void> | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    ...getMainWindowOptions(process.platform),
    webPreferences: {
      preload: path.join(app.getAppPath(), "src", "preload", "index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openSafeWebUrl(url);
    return { action: "deny" };
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function openMainConsoleWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }

  mainWindow.focus();
}

function emitPetEnabled(enabled: boolean): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(PET_ENABLED_CHANNEL, enabled);
}

async function disablePetWindowFromMenu(sourceWindow: BrowserWindow): Promise<void> {
  const current = runtime.getConfig();

  if (!current.pet.enabled) {
    if (!sourceWindow.isDestroyed()) {
      sourceWindow.close();
    }
    emitPetEnabled(false);
    return;
  }

  try {
    await runtime.saveConfig({
      ...current,
      pet: {
        ...current.pet,
        enabled: false
      }
    });
    emitPetEnabled(false);
  } catch (error) {
    logger.warn("index", "disable-pet-from-menu-failed", undefined, error);
    if (!sourceWindow.isDestroyed()) {
      sourceWindow.close();
    }
  }
}

async function toggleFreeConversationFromMenu(sourceWindow: BrowserWindow): Promise<void> {
  const current = runtime.getConfig();
  const enabled = current.realtimeVoice.enabled && current.realtimeVoice.mode === "free";

  try {
    if (enabled) {
      await runtime.saveConfig({
        ...current,
        realtimeVoice: {
          ...current.realtimeVoice,
          enabled: false,
          mode: "ptt"
        }
      });
      await runtime.stopVoiceSession();
      return;
    }

    await runtime.saveConfig({
      ...current,
      realtimeVoice: {
        ...current.realtimeVoice,
        enabled: true,
        mode: "free"
      }
    });
    await runtime.startVoiceSession({
      mode: "free"
    });
  } catch (error) {
    logger.warn("index", "toggle-free-conversation-from-menu-failed", undefined, error);
    if (!sourceWindow.isDestroyed()) {
      sourceWindow.focus();
    }
  }
}

function registerShellMenuIpc(): void {
  ipcMain.on(
    "pet:menu:show",
    (event, payload?: { x?: number; y?: number }) => {
      const sourceWindow = BrowserWindow.fromWebContents(event.sender);
      if (!sourceWindow || sourceWindow.isDestroyed()) {
        return;
      }

      const x = Number.isFinite(payload?.x) ? Math.round(payload?.x ?? 0) : undefined;
      const y = Number.isFinite(payload?.y) ? Math.round(payload?.y ?? 0) : undefined;
      const current = runtime.getConfig();
      const menu = Menu.buildFromTemplate(
        buildPetContextMenuTemplate(current, {
          openConsole: () => {
            openMainConsoleWindow();
          },
          disablePet: () => {
            void disablePetWindowFromMenu(sourceWindow);
          },
          toggleSpeechReply: () => {
            void runtime.saveConfig({
              ...current,
              realtimeVoice: {
                ...current.realtimeVoice,
                speechReplyEnabled: !current.realtimeVoice.speechReplyEnabled
              }
            }).catch((error) => {
              logger.warn("index", "toggle-speech-reply-from-menu-failed", undefined, error);
              if (!sourceWindow.isDestroyed()) {
                sourceWindow.focus();
              }
            });
          },
          toggleFreeConversation: () => {
            void toggleFreeConversationFromMenu(sourceWindow);
          }
        })
      );

      menu.popup({
        window: sourceWindow,
        x,
        y
      });
    }
  );
}

app.whenReady().then(async () => {
  registerShellMenuIpc();
  registerIpcHandlers(runtime);

  await runtime.init();
  createWindow();
  void runtime.start().catch((error) => {
    logger.error("index", "runtime-start-failed", undefined, error);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch((error) => {
  logger.error("index", "app-start-failed", undefined, error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (shutdownRequested) {
    return;
  }

  shutdownRequested = true;
  event.preventDefault();
  const timer = setTimeout(() => {
    app.exit(0);
  }, 5000);
  timer.unref?.();

  shutdownPromise ??= runtime.stop().catch((error) => {
    logger.error("index", "runtime-stop-failed", undefined, error);
  });

  void shutdownPromise.finally(() => {
    clearTimeout(timer);
    app.exit(0);
  });
});
