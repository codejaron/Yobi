import path from "node:path";
import { existsSync } from "node:fs";

export function platformKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

export function executableName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "yobi-native-audio.exe" : "yobi-native-audio";
}

export interface ResolveNativeAudioHelperPathInput {
  platform: NodeJS.Platform;
  arch: string;
  envOverride: string;
  resourcesPath: string;
  appPath: string;
  helperExists: (candidate: string) => boolean;
}

export function resolveNativeAudioHelperPathFrom(input: ResolveNativeAudioHelperPathInput): string {
  const pathApi = input.platform === "win32" ? path.win32 : path.posix;
  const override = input.envOverride.trim();
  if (override) {
    return override;
  }

  const packagedPath = pathApi.join(
    input.resourcesPath,
    "native-audio",
    "bin",
    platformKey(input.platform, input.arch),
    executableName(input.platform)
  );
  if (input.helperExists(packagedPath)) {
    return packagedPath;
  }

  return pathApi.join(
    input.appPath,
    "resources",
    "native-audio",
    "bin",
    platformKey(input.platform, input.arch),
    executableName(input.platform)
  );
}

export async function resolveNativeAudioHelperPath(): Promise<string> {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new Error(`native audio helper is unsupported on ${process.platform}`);
  }

  const electron = await import("electron");
  return resolveNativeAudioHelperPathFrom({
    platform: process.platform,
    arch: process.arch,
    envOverride: process.env.YOBI_NATIVE_AUDIO_HELPER_PATH?.trim() ?? "",
    resourcesPath: process.resourcesPath,
    appPath: electron.app.getAppPath(),
    helperExists: existsSync
  });
}
