import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { ChatMediaStore } from "../services/chat-media.js";
import { CompanionPaths } from "../storage/paths.js";

async function createTempPaths(prefix: string): Promise<CompanionPaths> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const paths = new CompanionPaths(baseDir);
  paths.ensureLayout();
  return paths;
}

async function cleanup(paths: CompanionPaths): Promise<void> {
  await fs.rm(paths.baseDir, { recursive: true, force: true });
}

function makePngBuffer(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x00
  ]);
}

test("ChatMediaStore: stores inbound channel images as chat attachments", async () => {
  const paths = await createTempPaths("yobi-chat-media-inbound-");
  try {
    const store = new ChatMediaStore(paths);

    const attachment = await (store as any).storeInboundImage({
      channel: "telegram",
      chatId: "chat-1",
      data: makePngBuffer(),
      filename: "photo.png"
    });

    assert.equal(attachment.kind, "image");
    assert.equal(attachment.mimeType, "image/png");
    assert.equal(attachment.source, "user-upload");
    await assert.doesNotReject(() => fs.access(attachment.path));
    assert.match(attachment.path, /chat-media/);
  } finally {
    await cleanup(paths);
  }
});
