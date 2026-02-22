import sharp from "sharp";

async function capturePrimaryRaw(): Promise<Buffer | null> {
  try {
    const imported = (await import("node-screenshots")) as Record<string, any>;
    const screenshots = (imported.default ?? imported) as Record<string, any>;

    const monitorFactory = screenshots.Monitor ?? screenshots.Screen;
    const monitors = monitorFactory?.all?.() ?? [];
    const primary = monitors[0];
    if (!primary) {
      return null;
    }

    const image =
      (typeof primary.captureImageSync === "function" && primary.captureImageSync()) ||
      (typeof primary.captureImage === "function" && (await primary.captureImage()));

    if (!image) {
      return null;
    }

    if (Buffer.isBuffer(image)) {
      return image;
    }

    if (typeof image.toPngSync === "function") {
      return Buffer.from(image.toPngSync());
    }

    if (typeof image.toPng === "function") {
      return Buffer.from(await image.toPng());
    }

    return null;
  } catch {
    return null;
  }
}

export async function captureCompressedScreenshot(options: {
  maxWidth: number;
  quality: number;
}): Promise<string | null> {
  const raw = await capturePrimaryRaw();
  if (!raw) {
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
