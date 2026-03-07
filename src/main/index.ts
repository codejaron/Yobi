import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, Menu } from "electron";
import { registerIpcHandlers } from "./ipc";
import { createRuntime } from "./app-runtime";
import { openSafeWebUrl } from "./utils/external-links";
import { CompanionPaths } from "@main/storage/paths";
import { AppLogger } from "@main/services/logger";
const logger = new AppLogger(new CompanionPaths());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PET_ENABLED_CHANNEL = "runtime:pet-enabled";
const runtime = createRuntime();

let mainWindow: BrowserWindow | null = null;
let shutdownRequested = false;
let shutdownPromise: Promise<void> | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 720,
    title: "Yobi Companion",
    backgroundColor: "#f5efe7",
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
      const menu = Menu.buildFromTemplate([
        {
          label: "打开 Yobi 控制台",
          click: () => {
            openMainConsoleWindow();
          }
        },
        {
          label: "退出桌宠",
          click: () => {
            void disablePetWindowFromMenu(sourceWindow);
          }
        }
      ]);

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
