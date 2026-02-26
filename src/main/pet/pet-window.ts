import path from "node:path";
import {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from "electron";

export class PetWindowController {
  private window: BrowserWindow | null = null;

  private showWindowWithoutFocus(): void {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }

    if (this.window.isVisible()) {
      return;
    }

    try {
      this.window.showInactive();
    } catch {
      this.window.show();
    }
  }

  private applyWindowPinning(alwaysOnTop: boolean): void {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }

    this.window.setAlwaysOnTop(alwaysOnTop, alwaysOnTop ? "screen-saver" : "normal");
    this.window.setVisibleOnAllWorkspaces(alwaysOnTop, {
      visibleOnFullScreen: alwaysOnTop
    });
  }

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

  private readonly setIgnoreMouseEventsListener = (event: IpcMainEvent, payload: unknown): void => {
    if (!payload || typeof payload !== "object") {
      return;
    }

    const next = payload as {
      ignore?: boolean;
      forward?: boolean;
    };

    if (typeof next.ignore !== "boolean") {
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

    senderWindow.setIgnoreMouseEvents(next.ignore, {
      forward: next.ignore ? next.forward !== false : false
    });
  };

  private readonly getCursorPointHandler = (
    event: IpcMainInvokeEvent
  ): { x: number; y: number; windowX: number; windowY: number } => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (
      !senderWindow ||
      senderWindow.isDestroyed() ||
      !this.window ||
      this.window.isDestroyed() ||
      senderWindow.id !== this.window.id
    ) {
      return { x: 0, y: 0, windowX: 0, windowY: 0 };
    }

    const point = screen.getCursorScreenPoint();
    const bounds = senderWindow.getBounds();
    return {
      x: Number(point.x),
      y: Number(point.y),
      windowX: Number(bounds.x),
      windowY: Number(bounds.y)
    };
  };

  constructor() {
    ipcMain.on("pet:window:move-by", this.moveWindowByListener);
    ipcMain.on("pet:window:set-ignore-mouse-events", this.setIgnoreMouseEventsListener);
    ipcMain.removeHandler("pet:window:get-cursor-position");
    ipcMain.handle("pet:window:get-cursor-position", this.getCursorPointHandler);
  }

  open(input: { modelDir: string; alwaysOnTop: boolean }): void {
    if (this.window && !this.window.isDestroyed()) {
      this.applyWindowPinning(input.alwaysOnTop);
      this.showWindowWithoutFocus();
      return;
    }

    const htmlPath = path.join(app.getAppPath(), "resources", "pet-window.html");
    const targetUrl = new URL(`file://${htmlPath}`);
    targetUrl.searchParams.set("modelDir", path.resolve(app.getAppPath(), input.modelDir));
    targetUrl.searchParams.set("appPath", app.getAppPath());

    this.window = new BrowserWindow({
      width: 380,
      height: 460,
      show: false,
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
    this.applyWindowPinning(input.alwaysOnTop);
    this.window.once("ready-to-show", () => {
      this.showWindowWithoutFocus();
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
      | { type: "ptt"; state: "start" | "stop" | "cancel"; reason?: string }
      | { type: "thinking"; value: "start" | "stop" }
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
