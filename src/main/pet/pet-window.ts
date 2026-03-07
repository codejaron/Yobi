import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from "electron";
import { CompanionPaths } from "@main/storage/paths";
import { AppLogger } from "@main/services/logger";

const logger = new AppLogger(new CompanionPaths());

export class PetWindowController {
  private window: BrowserWindow | null = null;
  private dockRepairTimer: NodeJS.Timeout | null = null;
  private lastAlwaysOnTop: boolean | null = null;
  private macWorkspacePinned = false;

  private ensureDockIconVisibleOnMac(): void {
    if (process.platform !== "darwin") {
      return;
    }

    try {
      app.setActivationPolicy("regular");
      app.dock?.show();
    } catch {}
  }

  private scheduleDockRepairOnMac(): void {
    if (process.platform !== "darwin") {
      return;
    }

    if (this.dockRepairTimer) {
      clearTimeout(this.dockRepairTimer);
      this.dockRepairTimer = null;
    }

    this.dockRepairTimer = setTimeout(() => {
      this.ensureDockIconVisibleOnMac();
      this.dockRepairTimer = null;
    }, 120);
  }

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

    const alwaysOnTopChanged = this.lastAlwaysOnTop !== alwaysOnTop;
    if (alwaysOnTopChanged) {
      this.window.setAlwaysOnTop(alwaysOnTop, alwaysOnTop ? "screen-saver" : "normal");
      this.lastAlwaysOnTop = alwaysOnTop;
    }

    if (process.platform === "darwin") {
      if (!this.macWorkspacePinned) {
        this.window.setVisibleOnAllWorkspaces(true, {
          visibleOnFullScreen: true
        });
        this.macWorkspacePinned = true;
        this.scheduleDockRepairOnMac();
      }
      return;
    }

    if (!alwaysOnTopChanged) {
      return;
    }

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
    ipcMain.on("pet:debug:log", (event, payload) => {
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      if (!senderWindow || senderWindow.isDestroyed() || !this.window || this.window.isDestroyed() || senderWindow.id !== this.window.id) {
        return;
      }
      const message = typeof payload?.message === "string" ? payload.message : "pet-debug";
      logger.info("pet-window", message, typeof payload?.detail === "object" && payload.detail ? payload.detail : undefined);
    });
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
    const modelJsonPath = findModelJsonPath(input.modelDir);
    const fallbackImagePath = modelJsonPath ? findFallbackImagePath(modelJsonPath) : null;
    const cubismCorePath = resolveExistingPath([
      path.join(input.modelDir, "live2dcubismcore.min.js"),
      path.join(input.modelDir, "runtime", "live2dcubismcore.min.js"),
      path.join(app.getAppPath(), "resources", "live2dcubismcore.min.js"),
      path.join(app.getAppPath(), "resources", "vendor", "live2dcubismcore.min.js")
    ]);
    const pixiScriptPath = resolveExistingPath([
      path.join(app.getAppPath(), "node_modules", "pixi.js", "dist", "browser", "pixi.min.js"),
      path.join(process.cwd(), "node_modules", "pixi.js", "dist", "browser", "pixi.min.js"),
      path.join(app.getAppPath(), "resources", "vendor", "pixi.min.js")
    ]);
    const live2dScriptPath = resolveExistingPath([
      path.join(app.getAppPath(), "node_modules", "pixi-live2d-display", "dist", "cubism4.min.js"),
      path.join(process.cwd(), "node_modules", "pixi-live2d-display", "dist", "cubism4.min.js"),
      path.join(app.getAppPath(), "resources", "vendor", "cubism4.min.js")
    ]);
    if (modelJsonPath) {
      targetUrl.searchParams.set("modelJsonUrl", pathToFileURL(modelJsonPath).toString());
    }
    if (fallbackImagePath) {
      targetUrl.searchParams.set("fallbackImageUrl", pathToFileURL(fallbackImagePath).toString());
    }
    if (cubismCorePath) {
      targetUrl.searchParams.set("cubismCoreUrl", pathToFileURL(cubismCorePath).toString());
    }
    if (pixiScriptPath) {
      targetUrl.searchParams.set("pixiScriptUrl", pathToFileURL(pixiScriptPath).toString());
    }
    if (live2dScriptPath) {
      targetUrl.searchParams.set("live2dScriptUrl", pathToFileURL(live2dScriptPath).toString());
    }

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
      skipTaskbar: process.platform !== "darwin",
      webPreferences: {
        preload: path.join(app.getAppPath(), "src", "preload", "pet.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    this.lastAlwaysOnTop = input.alwaysOnTop;
    this.macWorkspacePinned = false;
    this.window.webContents.on("did-finish-load", () => {
      logger.info("pet-window", "did-finish-load");
    });
    this.window.webContents.on("did-fail-load", (_event, code, description) => {
      logger.error("pet-window", "did-fail-load", { code, description });
    });
    this.window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      const detail = { level, line, sourceId };
      if (level >= 2) logger.error("pet-window", message, detail);
      else logger.info("pet-window", message, detail);
    });
    this.window.webContents.on("render-process-gone", (_event, details) => {
      logger.error("pet-window", "render-process-gone", {
        reason: details.reason,
        exitCode: details.exitCode
      });
    });
    this.window.on("unresponsive", () => {
      logger.warn("pet-window", "window-unresponsive");
    });
    this.window.on("responsive", () => {
      logger.info("pet-window", "window-responsive");
    });
    this.window.once("ready-to-show", () => {
      this.applyWindowPinning(input.alwaysOnTop);
      this.showWindowWithoutFocus();
    });

    this.window.loadURL(targetUrl.toString()).catch(() => undefined);
    this.window.on("closed", () => {
      this.window = null;
      this.lastAlwaysOnTop = null;
      this.macWorkspacePinned = false;
    });
  }

  close(): void {
    if (this.dockRepairTimer) {
      clearTimeout(this.dockRepairTimer);
      this.dockRepairTimer = null;
    }

    if (!this.window || this.window.isDestroyed()) {
      this.window = null;
      this.lastAlwaysOnTop = null;
      this.macWorkspacePinned = false;
      return;
    }

    this.window.close();
    this.window = null;
    this.lastAlwaysOnTop = null;
    this.macWorkspacePinned = false;
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

function findModelJsonPath(modelDir: string): string | null {
  const candidateDirs = buildCandidateDirs(modelDir);
  for (const dir of candidateDirs) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".model3.json")) {
        continue;
      }
      return path.join(dir, entry.name);
    }
  }
  return null;
}

function findFallbackImagePath(modelJsonPath: string): string | null {
  try {
    const raw = fs.readFileSync(modelJsonPath, "utf8");
    const parsed = JSON.parse(raw) as {
      FileReferences?: {
        Textures?: string[];
      };
    };
    const modelBaseDir = path.dirname(modelJsonPath);
    const textures = Array.isArray(parsed?.FileReferences?.Textures) ? parsed.FileReferences.Textures : [];
    for (const texture of textures) {
      if (typeof texture !== "string" || !texture.trim()) {
        continue;
      }
      const candidate = path.join(modelBaseDir, texture);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {}

  const candidateDirs = buildCandidateDirs(path.dirname(modelJsonPath));
  for (const dir of candidateDirs) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!/texture_\d+\.png$/i.test(entry.name) && !/\.png$/i.test(entry.name)) {
        continue;
      }
      return path.join(dir, entry.name);
    }
  }

  return null;
}

function buildCandidateDirs(baseDir: string): string[] {
  const candidates = [baseDir, path.join(baseDir, "runtime")];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return candidates;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const childDir = path.join(baseDir, entry.name);
    candidates.push(childDir, path.join(childDir, "runtime"));
  }

  return Array.from(new Set(candidates));
}


function resolveExistingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}
