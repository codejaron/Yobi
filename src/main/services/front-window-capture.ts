import { nativeImage } from "electron";
import type { ChatAttachment, ChatAttachmentSource, CompanionModeFrontWindow } from "@shared/types";
import type { ChatMediaStore } from "./chat-media";
import { captureWindowImage } from "./window-capture-service";

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
  const captured = await captureWindowImage({
    appName: input.appName
  });
  if (!captured) {
    return null;
  }

  const image = nativeImage.createFromBuffer(captured.pngBuffer);
  const diffImage = resizeWithin(image, input.diffMaxEdge ?? 160);
  const diffSize = diffImage.getSize();
  const modelImage = resizeWithin(image, input.modelMaxEdge ?? 1024);
  const modelSize = modelImage.getSize();
  const jpegBuffer = modelImage.toJPEG(Math.max(1, Math.min(100, input.jpegQuality ?? 75)));
  const frontWindow: CompanionModeFrontWindow = {
    appName: captured.appName,
    title: captured.title,
    focused: captured.focused
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
