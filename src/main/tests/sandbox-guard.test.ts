import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { DEFAULT_CONFIG, type AppConfig } from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import { SandboxGuard } from "@main/tools/guard/sandbox";

function cloneConfig(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

test("SandboxGuard: chat-media root is read-only when added as internal read root", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "yobi-sandbox-"));
  const paths = new CompanionPaths(baseDir);
  paths.ensureLayout();

  try {
    const config = cloneConfig();
    config.tools.file.readEnabled = true;
    config.tools.file.writeEnabled = true;
    config.tools.file.allowedPaths = [paths.baseDir];

    const guard = new SandboxGuard(() => config, [paths.chatMediaDir]);
    const targetPath = path.join(paths.chatMediaDir, "capture.txt");

    assert.equal(guard.ensureFileReadAllowed(targetPath), targetPath);
    assert.throws(() => guard.ensureFileWriteAllowed(targetPath), /内部只读目录/);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});
