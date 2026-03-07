import { BrowserWindow } from "electron";
import type { AppConfig, ClawEvent, ClawHistoryItem } from "@shared/types";
import { ClawChannel } from "@main/claw/claw-channel";
import { ClawClient } from "@main/claw/claw-client";
import { OpenClawRuntime } from "@main/openclaw/runtime";
import { openSafeWebUrl } from "@main/utils/external-links";

interface ClawCoordinatorInput {
  openclawRuntime: OpenClawRuntime;
  clawClient: ClawClient;
  clawChannel: ClawChannel;
  getConfig: () => AppConfig;
}

export class ClawCoordinator {
  private listeners = new Set<(event: ClawEvent) => void>();
  private openclawWebUiWindow: BrowserWindow | null = null;

  constructor(private readonly input: ClawCoordinatorInput) {
    this.input.clawChannel.onEvent((event) => {
      for (const listener of this.listeners) {
        listener(event);
      }
    });
  }

  onEvent(listener: (event: ClawEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getConnectionEvent(): ClawEvent {
    const status = this.input.clawClient.getConnectionStatus();
    return {
      type: "connection",
      state: status.state,
      message: status.message,
      timestamp: new Date().toISOString()
    };
  }

  getTaskMonitorEvent(): ClawEvent {
    return this.input.clawChannel.getTaskMonitorEvent();
  }

  getOpenClawStatus(): { online: boolean; message: string } {
    return this.input.openclawRuntime.getStatus();
  }

  async start(): Promise<void> {
    const config = this.input.getConfig();
    await this.input.openclawRuntime.start(config);
    const status = this.input.openclawRuntime.getStatus();
    if (config.openclaw.enabled && status.online) {
      void this.input.clawChannel.connect().catch(() => undefined);
      return;
    }
    await this.input.clawChannel.disconnect();
  }

  async stop(): Promise<void> {
    await this.input.clawChannel.disconnect();
    await this.input.openclawRuntime.stop();
    this.input.clawChannel.dispose();
    if (this.openclawWebUiWindow && !this.openclawWebUiWindow.isDestroyed()) {
      this.openclawWebUiWindow.close();
    }
    this.openclawWebUiWindow = null;
  }

  async restartForConfig(nextConfig: AppConfig): Promise<void> {
    await this.input.clawChannel.disconnect();
    await this.input.openclawRuntime.start(nextConfig);
    if (nextConfig.openclaw.enabled && this.input.openclawRuntime.getStatus().online) {
      await this.input.clawChannel.connect();
    }
  }

  async connect(): Promise<{ connected: boolean; message: string }> {
    const gatewayReadyReason = this.getGatewayReadyError();
    if (gatewayReadyReason) {
      return {
        connected: false,
        message: gatewayReadyReason
      };
    }

    try {
      await this.input.clawChannel.connect();
      return {
        connected: true,
        message: "Claw 已连接"
      };
    } catch (error) {
      return {
        connected: false,
        message: error instanceof Error ? error.message : "Claw 连接失败"
      };
    }
  }

  async disconnect(): Promise<{ connected: boolean; message: string }> {
    await this.input.clawChannel.disconnect();
    return {
      connected: false,
      message: "Claw 已断开"
    };
  }

  async send(message: string): Promise<{ accepted: boolean; message: string }> {
    const normalized = message.trim();
    if (!normalized) {
      throw new Error("消息不能为空");
    }

    const gatewayReadyReason = this.getGatewayReadyError();
    if (gatewayReadyReason) {
      return {
        accepted: false,
        message: gatewayReadyReason
      };
    }

    try {
      await this.input.clawChannel.sendFromClaw("main", normalized);
      return {
        accepted: true,
        message: "消息已发送到 Claw"
      };
    } catch (error) {
      return {
        accepted: false,
        message: error instanceof Error ? error.message : "发送失败"
      };
    }
  }

  async history(limit = 50): Promise<{ items: ClawHistoryItem[] }> {
    const gatewayReadyReason = this.getGatewayReadyError();
    if (gatewayReadyReason) {
      return {
        items: []
      };
    }
    const items = await this.input.clawChannel.getHistory("main", limit);
    return { items };
  }

  async abort(): Promise<{ accepted: boolean; message: string }> {
    const gatewayReadyReason = this.getGatewayReadyError();
    if (gatewayReadyReason) {
      return {
        accepted: false,
        message: gatewayReadyReason
      };
    }

    try {
      await this.input.clawChannel.abort("main");
      return {
        accepted: true,
        message: "已发送中止请求"
      };
    } catch (error) {
      return {
        accepted: false,
        message: error instanceof Error ? error.message : "中止失败"
      };
    }
  }

  async openWebUi(): Promise<{ opened: boolean; message: string }> {
    const config = this.input.getConfig();
    if (!config.openclaw.enabled) {
      return {
        opened: false,
        message: "OpenClaw 未启用，请先开启并保存配置。"
      };
    }

    const status = this.input.openclawRuntime.getStatus();
    if (!status.online) {
      return {
        opened: false,
        message: `OpenClaw Gateway 尚未就绪：${status.message}`
      };
    }

    try {
      const dashboardUrl = await this.input.openclawRuntime.getDashboardUrl();
      if (this.openclawWebUiWindow && !this.openclawWebUiWindow.isDestroyed()) {
        if (this.openclawWebUiWindow.isMinimized()) {
          this.openclawWebUiWindow.restore();
        }
        if (!this.openclawWebUiWindow.isVisible()) {
          this.openclawWebUiWindow.show();
        }
        void this.openclawWebUiWindow.loadURL(dashboardUrl);
        this.openclawWebUiWindow.focus();
        return {
          opened: true,
          message: "已在应用内打开 OpenClaw Web UI。"
        };
      }

      const window = new BrowserWindow({
        width: 1280,
        height: 840,
        minWidth: 960,
        minHeight: 640,
        title: "OpenClaw Web UI",
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      });

      window.webContents.setWindowOpenHandler(({ url }) => {
        void openSafeWebUrl(url);
        return { action: "deny" };
      });

      this.openclawWebUiWindow = window;
      window.on("closed", () => {
        if (this.openclawWebUiWindow === window) {
          this.openclawWebUiWindow = null;
        }
      });

      await window.loadURL(dashboardUrl);
      return {
        opened: true,
        message: "已在应用内打开 OpenClaw Web UI。"
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "未知错误";
      return {
        opened: false,
        message: `打开失败：${detail}`
      };
    }
  }

  private getGatewayReadyError(): string | null {
    const config = this.input.getConfig();
    if (!config.openclaw.enabled) {
      return "OpenClaw 未启用";
    }
    const status = this.input.openclawRuntime.getStatus();
    if (!status.online) {
      return "OpenClaw Gateway 尚未就绪，请稍后再试。";
    }
    return null;
  }
}
