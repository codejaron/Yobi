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

function makePngBase64(): string {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x00
  ]).toString("base64");
}

test("ChatMediaStore: stores supported console attachments", async () => {
  const paths = await createTempPaths("yobi-chat-media-store-");
  try {
    const store = new ChatMediaStore(paths);
    const attachments = await store.storeConsoleAttachments({
      threadId: "thread-1",
      attachments: [
        {
          name: "screen.png",
          mimeType: "image/png",
          dataBase64: makePngBase64()
        },
        {
          name: "notes.md",
          mimeType: "text/markdown",
          dataBase64: Buffer.from("# hello\nworld", "utf8").toString("base64")
        }
      ]
    });

    assert.equal(attachments.length, 2);
    assert.equal(attachments[0]?.kind, "image");
    assert.equal(attachments[0]?.mimeType, "image/png");
    assert.equal(attachments[1]?.kind, "file");
    assert.equal(attachments[1]?.mimeType, "text/plain");
    await assert.doesNotReject(() => fs.access(attachments[0]?.path ?? ""));
    await assert.doesNotReject(() => fs.access(attachments[1]?.path ?? ""));
  } finally {
    await cleanup(paths);
  }
});

test("ChatMediaStore: rejects unsupported binary attachments", async () => {
  const paths = await createTempPaths("yobi-chat-media-reject-");
  try {
    const store = new ChatMediaStore(paths);
    await assert.rejects(
      () =>
        store.storeConsoleAttachments({
          threadId: "thread-1",
          attachments: [
            {
              name: "archive.bin",
              mimeType: "application/octet-stream",
              dataBase64: Buffer.from([0x00, 0x01, 0x02, 0x03]).toString("base64")
            }
          ]
        }),
      /类型不受支持/
    );
  } finally {
    await cleanup(paths);
  }
});

test("ChatMediaStore: cleanupExpired removes files older than retention window", async () => {
  const paths = await createTempPaths("yobi-chat-media-cleanup-");
  try {
    const store = new ChatMediaStore(paths);
    const attachment = await store.storeToolMedia({
      mediaType: "image/png",
      data: Buffer.from(makePngBase64(), "base64"),
      prefix: "browser",
      filename: "browser-screenshot.png"
    });
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await fs.utimes(attachment.path, eightDaysAgo, eightDaysAgo);

    const removed = await store.cleanupExpired(7, new Date());

    assert.equal(removed, 1);
    await assert.rejects(() => fs.access(attachment.path));
  } finally {
    await cleanup(paths);
  }
});

test("ChatMediaStore: reads stored image previews as data URLs", async () => {
  const paths = await createTempPaths("yobi-chat-media-preview-");
  try {
    const store = new ChatMediaStore(paths);
    const attachment = await store.storeToolMedia({
      mediaType: "image/png",
      data: Buffer.from(makePngBase64(), "base64"),
      prefix: "browser",
      filename: "browser-screenshot.png"
    });

    const previewUrl = await (store as any).readImagePreviewDataUrl({
      path: attachment.path,
      mimeType: attachment.mimeType
    });

    assert.equal(previewUrl, `data:image/png;base64,${makePngBase64()}`);
  } finally {
    await cleanup(paths);
  }
});

test("ChatMediaStore: does not read image previews outside the chat media directory", async () => {
  const paths = await createTempPaths("yobi-chat-media-preview-guard-");
  try {
    const store = new ChatMediaStore(paths);
    const outsiderPath = path.join(paths.baseDir, "outside.png");
    await fs.writeFile(outsiderPath, Buffer.from(makePngBase64(), "base64"));

    const previewUrl = await (store as any).readImagePreviewDataUrl({
      path: outsiderPath,
      mimeType: "image/png"
    });

    assert.equal(previewUrl, null);
  } finally {
    await cleanup(paths);
  }
});
