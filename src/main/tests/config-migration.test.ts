import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { CompanionPaths } from "../storage/paths.js";
import { ConfigStore } from "../storage/config.js";
import { DEFAULT_CONFIG } from "@shared/types";

test("ConfigStore: migrates legacy context budget and embedded Exa MCP config", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "yobi-config-migrate-"));

  try {
    const paths = new CompanionPaths(baseDir);
    paths.ensureLayout();

    const legacyConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Record<string, any>;
    delete legacyConfig.tools.exa;
    legacyConfig.openclaw = {
      contextTokens: 120_000
    };
    legacyConfig.tools.mcp.servers = [
      {
        id: "exa",
        label: "Exa Search",
        enabled: false,
        transport: "remote",
        url: "https://mcp.exa.ai/mcp",
        headers: {}
      },
      {
        id: "docs",
        label: "Docs",
        enabled: true,
        transport: "remote",
        url: "https://example.com/mcp",
        headers: {
          Authorization: "Bearer demo"
        }
      }
    ];

    await fs.writeFile(paths.configPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, "utf8");

    const store = new ConfigStore(paths);
    await store.init();
    const config = store.getConfig();

    assert.equal(config.memory.context.maxPromptTokens, 24_000);
    assert.equal(config.tools.exa.enabled, false);
    assert.equal(config.tools.mcp.servers.length, 1);
    assert.equal(config.tools.mcp.servers[0]?.id, "docs");
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test("ConfigStore: fills appearance defaults for config without theme settings", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "yobi-config-theme-"));

  try {
    const paths = new CompanionPaths(baseDir);
    paths.ensureLayout();

    const legacyConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Record<string, unknown>;
    delete legacyConfig.appearance;

    await fs.writeFile(paths.configPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, "utf8");

    const store = new ConfigStore(paths);
    await store.init();
    const config = store.getConfig();

    assert.deepEqual(config.appearance, {
      themeMode: "system"
    });
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});
