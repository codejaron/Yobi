import path from "node:path";
import type { Readable } from "node:stream";
import { MAX_ATTACHMENT_BYTES } from "@main/services/chat-media";

export async function readResponseBuffer(
  response: Pick<Response, "ok" | "status" | "arrayBuffer">
): Promise<Buffer> {
  if (!response.ok) {
    throw new Error(`download failed with status ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    throw new Error("download returned empty content");
  }
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`download exceeded ${MAX_ATTACHMENT_BYTES} bytes`);
  }

  return buffer;
}

export async function readReadableStreamBuffer(
  stream: Readable | NodeJS.ReadableStream
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_ATTACHMENT_BYTES) {
      throw new Error(`download exceeded ${MAX_ATTACHMENT_BYTES} bytes`);
    }
    chunks.push(buffer);
  }

  if (totalBytes === 0) {
    throw new Error("download returned empty content");
  }

  return Buffer.concat(chunks);
}

export function filenameFromUrl(url: string, fallback: string): string {
  const normalized = url.trim();
  if (!normalized) {
    return fallback;
  }

  try {
    const pathname = new URL(normalized).pathname;
    const basename = path.basename(pathname).trim();
    return basename || fallback;
  } catch {
    return fallback;
  }
}

export function resolveInboundImageText(input: {
  text?: string | null;
}): string {
  return String(input.text ?? "").trim();
}
