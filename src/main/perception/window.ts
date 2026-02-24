import activeWindow from "active-win";

export interface ActiveWindowInfo {
  title: string;
  appName: string;
  appId: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
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
      appId: owner?.bundleId ?? owner?.processId?.toString() ?? "unknown",
      bounds: {
        x: current.bounds?.x ?? 0,
        y: current.bounds?.y ?? 0,
        width: current.bounds?.width ?? 0,
        height: current.bounds?.height ?? 0
      }
    };
  } catch {
    return null;
  }
}
