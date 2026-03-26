import { nativeImage } from "electron";
import type { ChatAttachment, ChatAttachmentSource, CompanionModeFrontWindow } from "@shared/types";
import type { ChatMediaStore } from "./chat-media";

type CaptureTarget = Record<string, unknown> & {
  captureImageSync?: () => unknown;
  captureImage?: () => Promise<unknown>;
};

type WindowTarget = CaptureTarget & {
  appName?: () => string;
  title?: () => string;
  isFocused?: () => boolean;
  z?: () => number;
};

type ScreenshotsModule = Record<string, unknown> & {
  Window?: {
    all?: () => WindowTarget[];
  };
};

export interface FrontWindowCaptureFrame {
  frontWindow: CompanionModeFrontWindow;
  diffBitmap: Buffer;
  diffSize: {
    width: number;
    height: number;
  };
  modelImage: {
    buffer: Buffer;
    mimeType: "image/jpeg";
    filename: string;
    width: number;
    height: number;
  };
  storeAttachment: () => Promise<ChatAttachment>;
}

export interface CaptureFrontWindowInput {
  chatMediaStore: ChatMediaStore;
  appName?: string;
  diffMaxEdge?: number;
  modelMaxEdge?: number;
  jpegQuality?: number;
  source?: ChatAttachmentSource;
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function readWindowAppName(target: WindowTarget): string {
  if (typeof target.appName !== "function") {
    return "";
  }

  try {
    return String(target.appName() ?? "").trim();
  } catch {
    return "";
  }
}

function readWindowTitle(target: WindowTarget): string {
  if (typeof target.title !== "function") {
    return "";
  }

  try {
    return String(target.title() ?? "").trim();
  } catch {
    return "";
  }
}

function readWindowFocused(target: WindowTarget): boolean {
  if (typeof target.isFocused !== "function") {
    return false;
  }

  try {
    return Boolean(target.isFocused());
  } catch {
    return false;
  }
}

function readWindowZ(target: WindowTarget): number {
  if (typeof target.z !== "function") {
    return Number.POSITIVE_INFINITY;
  }

  try {
    const z = Number(target.z());
    return Number.isFinite(z) ? z : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

async function normalizeCapturedImage(image: unknown): Promise<Buffer | null> {
  if (!image) {
    return null;
  }

  if (Buffer.isBuffer(image)) {
    return image;
  }

  if (typeof image === "object") {
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

async function captureTargetImage(target: CaptureTarget): Promise<Buffer | null> {
  const image =
    (typeof target.captureImageSync === "function" && target.captureImageSync()) ||
    (typeof target.captureImage === "function" && (await target.captureImage()));

  return normalizeCapturedImage(image);
}

async function loadScreenshotsModule(): Promise<ScreenshotsModule | null> {
  try {
    const imported = (await import("node-screenshots")) as Record<string, unknown>;
    return (imported.default ?? imported) as ScreenshotsModule;
  } catch {
    return null;
  }
}

function selectWindowTarget(windows: WindowTarget[], appName?: string): WindowTarget {
  const requestedApp = normalizeText(appName);
  const filtered =
    requestedApp.length === 0
      ? windows
      : windows.filter((item) => {
          const current = normalizeText(readWindowAppName(item));
          return current === requestedApp || current.includes(requestedApp);
        });

  if (filtered.length === 0) {
    return windows.slice().sort((a, b) => readWindowZ(a) - readWindowZ(b))[0] as WindowTarget;
  }

  const focused = filtered.find((item) => readWindowFocused(item));
  if (focused) {
    return focused;
  }

  return filtered.slice().sort((a, b) => readWindowZ(a) - readWindowZ(b))[0] as WindowTarget;
}

function resizeWithin(image: Electron.NativeImage, maxEdge: number): Electron.NativeImage {
  const size = image.getSize();
  const currentMaxEdge = Math.max(size.width, size.height);
  if (currentMaxEdge <= 0 || currentMaxEdge <= maxEdge) {
    return image;
  }

  const scale = maxEdge / currentMaxEdge;
  return image.resize({
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
    quality: "good"
  });
}

export async function captureFrontWindowFrame(input: CaptureFrontWindowInput): Promise<FrontWindowCaptureFrame | null> {
  const screenshots = await loadScreenshotsModule();
  if (!screenshots) {
    return null;
  }

  const windows = screenshots.Window?.all?.() ?? [];
  if (windows.length === 0) {
    return null;
  }

  const target = selectWindowTarget(windows, input.appName);
  const pngBuffer = await captureTargetImage(target);
  if (!pngBuffer) {
    return null;
  }

  const image = nativeImage.createFromBuffer(pngBuffer);
  const diffImage = resizeWithin(image, input.diffMaxEdge ?? 160);
  const diffSize = diffImage.getSize();
  const modelImage = resizeWithin(image, input.modelMaxEdge ?? 1024);
  const modelSize = modelImage.getSize();
  const jpegBuffer = modelImage.toJPEG(Math.max(1, Math.min(100, input.jpegQuality ?? 75)));
  const frontWindow: CompanionModeFrontWindow = {
    appName: readWindowAppName(target),
    title: readWindowTitle(target),
    focused: readWindowFocused(target)
  };

  return {
    frontWindow,
    diffBitmap: Buffer.from(diffImage.toBitmap()),
    diffSize,
    modelImage: {
      buffer: jpegBuffer,
      mimeType: "image/jpeg",
      filename: "companion-capture.jpg",
      width: modelSize.width,
      height: modelSize.height
    },
    storeAttachment: () =>
      input.chatMediaStore.storeToolMedia({
        mediaType: "image/jpeg",
        data: jpegBuffer,
        prefix: "companion",
        filename: "companion-capture.jpg",
        source: input.source ?? "companion-capture"
      })
  };
}
