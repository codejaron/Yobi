import path from "node:path";
import { existsSync } from "node:fs";

export function platformKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

export function executableName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "yobi-mac-screen-capture.exe" : "yobi-mac-screen-capture";
}

export interface ResolveMacCaptureHelperPathInput {
  platform: NodeJS.Platform;
  arch: string;
  envOverride: string;
  resourcesPath: string;
  appPath: string;
  helperExists: (candidate: string) => boolean;
}

export function resolveMacCaptureHelperPathFrom(input: ResolveMacCaptureHelperPathInput): string {
  const override = input.envOverride.trim();
  if (override) {
    return override;
  }

  const packagedPath = path.join(
    input.resourcesPath,
    "mac-screen-capture",
    "bin",
    platformKey(input.platform, input.arch),
    executableName(input.platform)
  );
  if (input.helperExists(packagedPath)) {
    return packagedPath;
  }

  return path.join(
    input.appPath,
    "resources",
    "mac-screen-capture",
    "bin",
    platformKey(input.platform, input.arch),
    executableName(input.platform)
  );
}

export async function resolveMacCaptureHelperPath(): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error(`mac capture helper is unsupported on ${process.platform}`);
  }

  const electron = await import("electron");
  return resolveMacCaptureHelperPathFrom({
    platform: process.platform,
    arch: process.arch,
    envOverride: process.env.YOBI_MAC_CAPTURE_HELPER_PATH?.trim() ?? "",
    resourcesPath: process.resourcesPath,
    appPath: electron.app.getAppPath(),
    helperExists: existsSync
  });
}
