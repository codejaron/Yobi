import path from "node:path";
import { existsSync } from "node:fs";

function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function executableName(): string {
  return process.platform === "win32" ? "sense-voice-main.exe" : "sense-voice-main";
}

export async function resolveSenseVoiceWorkerPath(): Promise<string> {
  const electron = await import("electron");
  return path.join(electron.app.getAppPath(), "src", "main", "workers", "sensevoice-sidecar.cjs");
}

export async function resolveSenseVoiceBackendPath(): Promise<string> {
  const override = process.env.YOBI_SENSEVOICE_BINARY_PATH?.trim();
  if (override) {
    return override;
  }

  const electron = await import("electron");
  const packagedPath = path.join(process.resourcesPath, "sensevoice", "bin", platformKey(), executableName());
  if (existsSync(packagedPath)) {
    return packagedPath;
  }

  return path.join(electron.app.getAppPath(), "resources", "sensevoice", "bin", platformKey(), executableName());
}
