import path from "node:path";
import { app, BrowserWindow, ipcMain, type IpcMainEvent } from "electron";

export class PetWindowController {
  private window: BrowserWindow | null = null;
  private readonly moveWindowByListener = (event: IpcMainEvent, payload: unknown): void => {
    if (!payload || typeof payload !== "object") {
      return;
    }

    const next = payload as {
      dx?: number;
      dy?: number;
    };
    const dx = Number(next.dx);
    const dy = Number(next.dy);

    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
      return;
    }

    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (
      !senderWindow ||
      senderWindow.isDestroyed() ||
      !this.window ||
      this.window.isDestroyed() ||
      senderWindow.id !== this.window.id
    ) {
      return;
    }

    const [x, y] = senderWindow.getPosition();
    senderWindow.setPosition(Math.round(x + dx), Math.round(y + dy));
  };

  constructor() {
    ipcMain.on("pet:window:move-by", this.moveWindowByListener);
  }

  open(input: { modelDir: string; alwaysOnTop: boolean }): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      return;
    }

    const htmlPath = path.join(app.getAppPath(), "resources", "pet-window.html");
    const targetUrl = new URL(`file://${htmlPath}`);
    targetUrl.searchParams.set("modelDir", path.resolve(app.getAppPath(), input.modelDir));
    targetUrl.searchParams.set("appPath", app.getAppPath());

    this.window = new BrowserWindow({
      width: 380,
      height: 460,
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: "#00000000",
      resizable: false,
      movable: true,
      alwaysOnTop: input.alwaysOnTop,
      skipTaskbar: true,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: true
      }
    });

    this.window.loadURL(targetUrl.toString()).catch(() => undefined);
    this.window.on("closed", () => {
      this.window = null;
    });
  }

  close(): void {
    if (!this.window || this.window.isDestroyed()) {
      this.window = null;
      return;
    }

    this.window.close();
    this.window = null;
  }

  emitEvent(
    event:
      | { type: "emotion"; value: string }
      | { type: "talking"; value: string }
      | { type: "speech"; audioBase64: string; mimeType?: string }
  ): void {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }

    this.window.webContents.send("pet:event", event);
  }

  isOnline(): boolean {
    return Boolean(this.window && !this.window.isDestroyed());
  }
}
