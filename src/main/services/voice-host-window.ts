import path from "node:path";
import type { BrowserWindow, MessagePortMain } from "electron";
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
  | { type: "pcm-frame"; pcm: ArrayBuffer; sampleRate: number }
  | { type: "playback-started"; id: string; text: string; queueLength: number }
  | { type: "playback-ended"; id: string; text: string; queueLength: number }
  | { type: "playback-cleared"; queueLength: number }
  | { type: "playback-error"; id?: string; message: string }
  | { type: "speech-level"; level: number; queueLength: number; currentText: string };

type Listener = (message: VoiceHostMessage) => void;

export class VoiceHostWindowController {
  private window: BrowserWindow | null = null;
  private port: MessagePortMain | null = null;
  private listeners = new Set<Listener>();
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;

  constructor(private readonly logger: AppLogger) {}

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async ensureReady(): Promise<void> {
    if (this.port && this.window && !this.window.isDestroyed()) {
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
    await this.ensureReady();
    this.port?.postMessage(command);
  }

  close(): void {
    try {
      this.port?.close();
    } catch {}
    this.port = null;

    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
    this.window = null;
    this.resolveReady = null;
  }

  private async createWindow(): Promise<void> {
    const electron = await import("electron");
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

    window.on("closed", () => {
      this.window = null;
      try {
        this.port?.close();
      } catch {}
      this.port = null;
      this.resolveReady = null;
    });

    await window.loadFile(htmlPath);

    const channel = new electron.MessageChannelMain();
    this.port = channel.port1;
    this.port.on("message", (event) => {
      const payload = event.data as VoiceHostMessage;
      if (payload?.type === "host-ready") {
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
    });
    this.port.start();

    this.window = window;
    window.webContents.postMessage("voice-host:port", null, [channel.port2]);

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
    });
  }
}
