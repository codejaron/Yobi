import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import { registerIpcHandlers } from "./ipc";
import { runtime } from "./runtime";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PET_ENABLED_CHANNEL = "runtime:pet-enabled";

let mainWindow: BrowserWindow | null = null;

function ensureDockIconVisibleOnMac(): void {
  if (process.platform !== "darwin") {
    return;
  }

  try {
    app.setActivationPolicy("regular");
    app.dock?.show();
  } catch (error) {
    console.warn("Failed to ensure dock icon on macOS:", error);
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 720,
    title: "Yobi Companion",
    backgroundColor: "#f5efe7",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
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
    console.warn("Failed to disable pet from menu:", error);
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
  ensureDockIconVisibleOnMac();

  registerShellMenuIpc();
  registerIpcHandlers();

  await runtime.init();
  createWindow();
  void runtime.start().catch((error) => {
    console.error("Failed to start runtime services:", error);
  });

  app.on("activate", () => {
    ensureDockIconVisibleOnMac();

    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch((error) => {
  console.error("Failed to start Yobi runtime:", error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
