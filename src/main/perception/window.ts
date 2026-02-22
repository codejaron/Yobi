import activeWindow from "active-win";

export interface ActiveWindowInfo {
  title: string;
  appName: string;
  appId: string;
}

export async function getActiveWindow(): Promise<ActiveWindowInfo | null> {
  try {
    const current = await activeWindow();
    if (!current) {
      return null;
    }

    const owner = current.owner as { name?: string; bundleId?: string; processId?: number } | undefined;
    return {
      title: current.title ?? "",
      appName: owner?.name ?? "Unknown",
      appId: owner?.bundleId ?? owner?.processId?.toString() ?? "unknown"
    };
  } catch {
    return null;
  }
}
