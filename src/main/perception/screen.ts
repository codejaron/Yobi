import sharp from "sharp";
import type { ActiveWindowInfo } from "./window";

type CaptureTarget = Record<string, unknown> & {
  captureImageSync?: () => unknown;
  captureImage?: () => Promise<unknown>;
};

type ScreenshotsModule = Record<string, unknown> & {
  Window?: {
    all?: () => CaptureTarget[];
  };
  Monitor?: {
    fromPoint?: (x: number, y: number) => CaptureTarget | null;
  };
  Screen?: {
    fromPoint?: (x: number, y: number) => CaptureTarget | null;
  };
};

function toNormalizedString(input: unknown): string {
  return (typeof input === "string" ? input : "").trim().toLowerCase();
}

function isFocusedWindow(item: Record<string, unknown>): boolean {
  const isFocused = item.isFocused;
  if (typeof isFocused !== "function") {
    return false;
  }
  try {
    return Boolean(isFocused.call(item));
  } catch {
    return false;
  }
}

function matchesWindow(item: Record<string, unknown>, windowInfo: ActiveWindowInfo): boolean {
  const titleGetter = item.title;
  const appNameGetter = item.appName;
  const title =
    typeof titleGetter === "function" ? toNormalizedString(titleGetter.call(item)) : "";
  const appName =
    typeof appNameGetter === "function" ? toNormalizedString(appNameGetter.call(item)) : "";
  return title === toNormalizedString(windowInfo.title) && appName === toNormalizedString(windowInfo.appName);
}

async function normalizeCapturedImage(image: unknown): Promise<Buffer | null> {
  if (!image) {
    return null;
  }

  if (Buffer.isBuffer(image)) {
    return image;
  }

  if (typeof image === "object" && image !== null) {
    const candidate = image as Record<string, unknown>;
    const toPngSync = candidate.toPngSync;
    if (typeof toPngSync === "function") {
      return Buffer.from(toPngSync.call(candidate));
    }

    const toPng = candidate.toPng;
    if (typeof toPng === "function") {
      return Buffer.from(await toPng.call(candidate));
    }
  }

  return null;
}

async function captureFromTarget(target: CaptureTarget | null | undefined): Promise<Buffer | null> {
  if (!target) {
    return null;
  }

  const image =
    (typeof target.captureImageSync === "function" && target.captureImageSync()) ||
    (typeof target.captureImage === "function" && (await target.captureImage()));

  return normalizeCapturedImage(image);
}

async function loadScreenshots(): Promise<ScreenshotsModule | null> {
  try {
    const imported = (await import("node-screenshots")) as Record<string, unknown>;
    return (imported.default ?? imported) as ScreenshotsModule;
  } catch {
    return null;
  }
}

async function captureActiveWindowRaw(
  screenshots: ScreenshotsModule,
  windowInfo: ActiveWindowInfo
): Promise<Buffer | null> {
  const windows = screenshots.Window?.all?.() ?? [];
  if (windows.length === 0) {
    return null;
  }

  const byFocusedAndMatched = windows.find(
    (item) => isFocusedWindow(item as Record<string, unknown>) && matchesWindow(item, windowInfo)
  );
  if (byFocusedAndMatched) {
    return captureFromTarget(byFocusedAndMatched);
  }

  const byFocused = windows.find((item) => isFocusedWindow(item as Record<string, unknown>));
  if (byFocused) {
    return captureFromTarget(byFocused);
  }

  const byMatchedMeta = windows.find((item) => matchesWindow(item, windowInfo));
  if (byMatchedMeta) {
    return captureFromTarget(byMatchedMeta);
  }

  return null;
}

async function captureMonitorByWindowPoint(
  screenshots: ScreenshotsModule,
  windowInfo: ActiveWindowInfo
): Promise<Buffer | null> {
  const monitorFactory = screenshots.Monitor ?? screenshots.Screen;
  const fromPoint = monitorFactory?.fromPoint;
  if (typeof fromPoint !== "function") {
    return null;
  }

  const bounds = windowInfo.bounds;
  const centerX = Math.floor(bounds.x + Math.max(bounds.width, 1) / 2);
  const centerY = Math.floor(bounds.y + Math.max(bounds.height, 1) / 2);
  const monitor = fromPoint(centerX, centerY);
  return captureFromTarget(monitor ?? null);
}

export async function captureCompressedScreenshot(options: {
  maxWidth: number;
  quality: number;
  windowInfo: ActiveWindowInfo;
}): Promise<string | null> {
  const screenshots = await loadScreenshots();
  if (!screenshots) {
    console.warn("[perception] Failed to load node-screenshots module.");
    return null;
  }

  let raw = await captureActiveWindowRaw(screenshots, options.windowInfo);
  if (!raw) {
    console.warn("[perception] Failed to capture active window, falling back to monitor capture.", {
      appName: options.windowInfo.appName,
      title: options.windowInfo.title
    });
    raw = await captureMonitorByWindowPoint(screenshots, options.windowInfo);
  }

  if (!raw) {
    console.warn("[perception] Failed to capture monitor by active window position.", {
      appName: options.windowInfo.appName,
      title: options.windowInfo.title,
      bounds: options.windowInfo.bounds
    });
    return null;
  }

  const compressed = await sharp(raw)
    .resize({
      width: options.maxWidth,
      withoutEnlargement: true
    })
    .jpeg({
      quality: options.quality,
      mozjpeg: true
    })
    .toBuffer();

  return compressed.toString("base64");
}
