import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { desktopCapturer, shell, systemPreferences } from "electron";
import type { PermissionState, SystemPermissionStatus } from "@shared/types";

const execFileAsync = promisify(execFile);

type SystemPermissionKey = keyof SystemPermissionStatus;
type MediaPermissionKey = "microphone" | "screen";

interface SystemPermissionsServiceInput {
  onStatusChange?: () => void | Promise<void>;
}

export class SystemPermissionsService {
  private systemPermissions: SystemPermissionStatus = {
    accessibility: "unknown",
    microphone: "unknown",
    screenCapture: "unknown"
  };

  constructor(private readonly input: SystemPermissionsServiceInput = {}) {}

  getSnapshot(): SystemPermissionStatus {
    return {
      ...this.systemPermissions
    };
  }

  refreshSystemPermissions(): void {
    this.systemPermissions = {
      accessibility: this.getSystemPermissionState("accessibility"),
      microphone: this.getSystemPermissionState("microphone"),
      screenCapture: this.getSystemPermissionState("screenCapture")
    };
  }

  async openSystemPermissionSettings(
    permission: SystemPermissionKey
  ): Promise<{ opened: boolean; prompted: boolean }> {
    const initialState = this.getSystemPermissionState(permission);
    this.systemPermissions[permission] = initialState;
    if (initialState === "granted") {
      await this.notifyStatusChange();
      return {
        opened: false,
        prompted: false
      };
    }

    let prompted = false;

    if (process.platform === "darwin") {
      if (permission === "accessibility") {
        try {
          prompted = true;
          systemPreferences.isTrustedAccessibilityClient(true);
        } catch (error) {
          console.warn("[runtime] request accessibility permission failed:", error);
        }
        this.systemPermissions.accessibility = this.getAccessibilityPermissionState();
      }

      if (permission === "microphone") {
        try {
          const rawStatus = this.getMediaAccessRawStatus("microphone");
          if (rawStatus === "not-determined") {
            prompted = true;
            const granted = await systemPreferences.askForMediaAccess("microphone");
            this.systemPermissions.microphone = granted ? "granted" : "denied";
          }
        } catch (error) {
          console.warn("[runtime] request microphone permission failed:", error);
        }
      }

      if (permission === "screenCapture") {
        const rawStatus = this.getMediaAccessRawStatus("screen");
        if (rawStatus === "not-determined") {
          prompted = true;
          await this.tryRequestScreenCapturePermissionOnMac();
        }
        this.systemPermissions.screenCapture = this.getMediaPermissionState("screen");
      }

      const latestState = this.getSystemPermissionState(permission);
      this.systemPermissions[permission] = latestState;
      await this.notifyStatusChange();
      if (latestState === "granted") {
        return {
          opened: false,
          prompted
        };
      }

      if (prompted) {
        return {
          opened: false,
          prompted: true
        };
      }
    }

    const target = this.resolveSystemPermissionSettingsTarget(permission);
    if (!target) {
      return {
        opened: false,
        prompted: false
      };
    }

    try {
      await shell.openExternal(target);
      return {
        opened: true,
        prompted: false
      };
    } catch (error) {
      console.warn("[runtime] open system permission settings failed:", error);
      return {
        opened: false,
        prompted: false
      };
    }
  }

  async resetSystemPermissions(): Promise<{ reset: boolean; message?: string }> {
    if (process.platform !== "darwin") {
      return {
        reset: false,
        message: "当前平台不支持重置系统权限。"
      };
    }

    try {
      const bundleId = await this.resolveCurrentBundleId();
      if (!bundleId) {
        return {
          reset: false,
          message: "无法识别当前应用标识，重置权限失败。"
        };
      }
      await execFileAsync("tccutil", ["reset", "All", bundleId]);
      await this.notifyStatusChange();
      return {
        reset: true,
        message: `已重置 ${bundleId} 的系统权限。`
      };
    } catch (error) {
      console.warn("[runtime] reset system permissions failed:", error);
      return {
        reset: false,
        message: "重置权限失败，请稍后重试。"
      };
    }
  }

  ensureGlobalPttPermission(): boolean {
    if (process.platform !== "darwin") {
      return true;
    }

    let granted = false;
    try {
      granted = systemPreferences.isTrustedAccessibilityClient(false);
    } catch {
      granted = false;
    }

    this.systemPermissions.accessibility = granted ? "granted" : "denied";
    return granted;
  }

  getSystemPermissionState(permission: SystemPermissionKey): PermissionState {
    if (permission === "accessibility") {
      return this.getAccessibilityPermissionState();
    }

    if (permission === "microphone") {
      return this.getMediaPermissionState("microphone");
    }

    return this.getMediaPermissionState("screen");
  }

  private getAccessibilityPermissionState(): PermissionState {
    if (process.platform !== "darwin") {
      return "granted";
    }

    try {
      return systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied";
    } catch {
      return "unknown";
    }
  }

  private getMediaPermissionState(permission: MediaPermissionKey): PermissionState {
    try {
      const status = this.getMediaAccessRawStatus(permission);
      return this.normalizeMediaPermissionState(status);
    } catch {
      return "unknown";
    }
  }

  private getMediaAccessRawStatus(permission: MediaPermissionKey): string {
    return systemPreferences.getMediaAccessStatus(permission);
  }

  private normalizeMediaPermissionState(raw: string): PermissionState {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "granted") {
      return "granted";
    }

    if (normalized === "denied" || normalized === "restricted") {
      return "denied";
    }

    return "unknown";
  }

  private async tryRequestScreenCapturePermissionOnMac(): Promise<void> {
    if (process.platform !== "darwin") {
      return;
    }

    try {
      await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: {
          width: 1,
          height: 1
        }
      });
    } catch (error) {
      console.warn("[runtime] request screen capture permission failed:", error);
    }
  }

  private async resolveCurrentBundleId(): Promise<string | null> {
    if (process.platform !== "darwin") {
      return null;
    }

    const marker = "/Contents/MacOS/";
    const markerIndex = process.execPath.indexOf(marker);
    if (markerIndex <= 0) {
      return null;
    }

    const appBundlePath = process.execPath.slice(0, markerIndex);
    const infoPlistPath = path.join(appBundlePath, "Contents", "Info");
    try {
      const { stdout } = await execFileAsync("defaults", [
        "read",
        infoPlistPath,
        "CFBundleIdentifier"
      ]);
      const bundleId = stdout.trim();
      return bundleId || null;
    } catch {
      return null;
    }
  }

  private resolveSystemPermissionSettingsTarget(permission: SystemPermissionKey): string | null {
    if (process.platform === "darwin") {
      const map: Record<SystemPermissionKey, string> = {
        accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        screenCapture: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
      };
      return map[permission];
    }

    if (process.platform === "win32") {
      const map: Record<SystemPermissionKey, string> = {
        accessibility: "ms-settings:easeofaccess",
        microphone: "ms-settings:privacy-microphone",
        screenCapture: "ms-settings:privacy"
      };
      return map[permission];
    }

    return null;
  }

  private async notifyStatusChange(): Promise<void> {
    await this.input.onStatusChange?.();
  }
}
