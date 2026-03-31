import path from "node:path";
import type { BrowserWindow, IpcMainEvent } from "electron";
import type { AppLogger } from "./logger";

export type VoiceHostCommand =
  | {
      type: "start-capture";
      aecEnabled: boolean;
    }
  | {
      type: "stop-capture";
    }
  | {
      type: "enqueue-playback";
      id: string;
      audioBase64: string;
      text: string;
      mimeType: string;
    }
  | {
      type: "clear-playback";
    };

export type VoiceHostMessage =
  | { type: "host-ready" }
  | { type: "capture-started" }
  | { type: "capture-stopped" }
  | { type: "capture-error"; message: string }
  | { type: "pcm-frame"; pcm: number[]; sampleRate: number }
  | { type: "playback-pcm-frame"; pcm: number[]; sampleRate: number }
  | { type: "playback-started"; id: string; text: string; queueLength: number }
  | { type: "playback-ended"; id: string; text: string; queueLength: number }
  | { type: "playback-cleared"; queueLength: number }
  | { type: "playback-error"; id?: string; message: string }
  | { type: "speech-level"; level: number; queueLength: number; currentText: string };

type Listener = (message: VoiceHostMessage) => void;

export function cleanupClosedVoiceHostWindowState<TWindow>(input: {
  window: TWindow | null;
  pendingWindow: TWindow | null;
  readyWindowId: number | null;
  closedWindow: TWindow;
  closedWindowId: number;
}): {
  window: TWindow | null;
  pendingWindow: TWindow | null;
  readyWindowId: number | null;
} {
  return {
    window: input.window === input.closedWindow ? null : input.window,
    pendingWindow:
      input.pendingWindow === input.closedWindow ? null : input.pendingWindow,
    readyWindowId:
      input.readyWindowId === input.closedWindowId ? null : input.readyWindowId
  };
}

export class VoiceHostWindowController {
  private window: BrowserWindow | null = null;
  private pendingWindow: BrowserWindow | null = null;
  private listeners = new Set<Listener>();
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private readyWindowId: number | null = null;
  private readonly commandChannel = "voice-host:command";
  private readonly eventChannel = "voice-host:event";
  private eventListenerRegistered = false;

  constructor(private readonly logger: AppLogger) {}

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async ensureReady(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) {
      return;
    }

    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.readyPromise = this.createWindow().finally(() => {
      this.readyPromise = null;
    });
    return this.readyPromise;
  }

  async send(command: VoiceHostCommand): Promise<void> {
    if (!this.window || this.window.isDestroyed()) {
      await this.ensureReady();
    }
    this.window?.webContents.send(this.commandChannel, command);
  }

  close(): void {
    const targetWindow = this.window ?? this.pendingWindow;
    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.close();
    }
    this.window = null;
    this.pendingWindow = null;
    this.resolveReady = null;
    this.readyWindowId = null;
  }

  private async createWindow(): Promise<void> {
    this.logger.info("voice-host", "create-window:start");
    const electron = await import("electron");
    if (!this.eventListenerRegistered) {
      electron.ipcMain.on(this.eventChannel, this.handleIpcEvent);
      this.eventListenerRegistered = true;
    }
    const appPath = electron.app.getAppPath();
    const preloadPath = path.join(appPath, "src", "preload", "voice-host.cjs");
    const htmlPath = path.join(appPath, "resources", "voice-host.html");

    const window = new electron.BrowserWindow({
      width: 1,
      height: 1,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    });
    const windowId = window.webContents.id;
    this.pendingWindow = window;

    window.webContents.on("did-finish-load", () => {
      this.logger.info("voice-host", "webcontents:did-finish-load");
    });

    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedUrl) => {
        this.logger.warn("voice-host", "webcontents:did-fail-load", {
          errorCode,
          errorDescription,
          validatedUrl
        });
      }
    );

    window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      this.logger.info("voice-host-renderer", message, {
        level,
        line,
        sourceId
      });
    });

    window.webContents.on("render-process-gone", (_event, detail) => {
      this.logger.warn("voice-host", "webcontents:render-process-gone", {
        reason: detail.reason,
        exitCode: detail.exitCode
      });
    });

    window.on("closed", () => {
      this.logger.info("voice-host", "create-window:closed");
      const next = cleanupClosedVoiceHostWindowState({
        window: this.window,
        pendingWindow: this.pendingWindow,
        readyWindowId: this.readyWindowId,
        closedWindow: window,
        closedWindowId: windowId
      });
      this.window = next.window;
      this.pendingWindow = next.pendingWindow;
      this.readyWindowId = next.readyWindowId;
      this.resolveReady = null;
    });

    await window.loadFile(htmlPath);

    try {
      const probe = await window.webContents.executeJavaScript(
        `({
          hasVoiceHost: typeof window.voiceHost === "object" && window.voiceHost !== null,
          hasOnCommand: Boolean(window.voiceHost && typeof window.voiceHost.onCommand === "function"),
          hasEmit: Boolean(window.voiceHost && typeof window.voiceHost.emit === "function")
        })`,
        true
      );
      this.logger.info("voice-host", "renderer:probe", probe as Record<string, unknown>);
    } catch (error) {
      this.logger.warn("voice-host", "renderer:probe-failed", undefined, error);
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.resolveReady = null;
        resolve();
      }, 1000);
      timer.unref?.();

      this.resolveReady = () => {
        clearTimeout(timer);
        this.resolveReady = null;
        resolve();
      };

      if (this.readyWindowId === windowId) {
        this.resolveReady();
      }
    });

    this.window = window;
    if (this.pendingWindow === window) {
      this.pendingWindow = null;
    }
    this.logger.info("voice-host", "create-window:command-ready");
  }

  private readonly handleIpcEvent = (event: IpcMainEvent, payload: VoiceHostMessage): void => {
    const activeWindow = [this.window, this.pendingWindow].find(
      (candidate) =>
        candidate &&
        !candidate.isDestroyed() &&
        event.sender.id === candidate.webContents.id
    );
    if (!activeWindow) {
      return;
    }

    if (
      payload?.type !== "pcm-frame" &&
      payload?.type !== "playback-pcm-frame" &&
      payload?.type !== "speech-level"
    ) {
      this.logger.info("voice-host", `message:${payload?.type ?? "unknown"}`);
    }
    if (payload?.type === "host-ready") {
      this.readyWindowId = event.sender.id;
      this.resolveReady?.();
      this.resolveReady = null;
    }

    for (const listener of this.listeners) {
      try {
        listener(payload);
      } catch (error) {
        this.logger.warn("voice-host", "message-listener-failed", undefined, error);
      }
    }
  };
}
