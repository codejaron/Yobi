import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, type AppConfig } from "@shared/types";
import { createSystemTool } from "@main/tools/system/system-tool";
import { WindowsAdapter } from "@main/tools/system/win-adapter";

function cloneConfig(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function executionContext(config: AppConfig) {
  return {
    channel: "console" as const,
    userMessage: "test",
    getConfig: () => config
  };
}

function setProcessPlatform(value: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    configurable: true,
    value
  });

  return () => {
    if (original) {
      Object.defineProperty(process, "platform", original);
    }
  };
}

test("createSystemTool: Windows type_text passes text to adapter", async (t) => {
  const restorePlatform = setProcessPlatform("win32");
  t.after(restorePlatform);

  const original = WindowsAdapter.prototype.typeText;
  let received = "";
  WindowsAdapter.prototype.typeText = async function (text: string): Promise<void> {
    received = text;
  };
  t.after(() => {
    WindowsAdapter.prototype.typeText = original;
  });

  const config = cloneConfig();
  config.tools.system.enabled = true;
  const tool = createSystemTool({
    getConfig: () => config,
    sandboxGuard: {
      ensureExecAllowed: () => undefined
    } as any
  });

  const result = await tool.execute({
    action: "type_text",
    text: "hello windows"
  }, executionContext(config));

  assert.equal(result.success, true);
  assert.equal(received, "hello windows");
});

test("createSystemTool: Windows press_keys passes keys to adapter", async (t) => {
  const restorePlatform = setProcessPlatform("win32");
  t.after(restorePlatform);

  const original = WindowsAdapter.prototype.pressKeys;
  let received: string[] = [];
  WindowsAdapter.prototype.pressKeys = async function (keys: string[]): Promise<void> {
    received = keys;
  };
  t.after(() => {
    WindowsAdapter.prototype.pressKeys = original;
  });

  const config = cloneConfig();
  config.tools.system.enabled = true;
  const tool = createSystemTool({
    getConfig: () => config,
    sandboxGuard: {
      ensureExecAllowed: () => undefined
    } as any
  });

  const result = await tool.execute({
    action: "press_keys",
    keys: ["ctrl", "a"]
  }, executionContext(config));

  assert.equal(result.success, true);
  assert.deepEqual(received, ["ctrl", "a"]);
});

test("createSystemTool: Windows get_windows passes appName to adapter", async (t) => {
  const restorePlatform = setProcessPlatform("win32");
  t.after(restorePlatform);

  const original = WindowsAdapter.prototype.getAppWindows;
  let received = "";
  WindowsAdapter.prototype.getAppWindows = async function (appName?: string): Promise<Array<{ title: string }>> {
    received = appName ?? "";
    return [{ title: "Inbox" }];
  };
  t.after(() => {
    WindowsAdapter.prototype.getAppWindows = original;
  });

  const config = cloneConfig();
  config.tools.system.enabled = true;
  const tool = createSystemTool({
    getConfig: () => config,
    sandboxGuard: {
      ensureExecAllowed: () => undefined
    } as any
  });

  const result = await tool.execute({
    action: "get_windows",
    appName: "Outlook"
  }, executionContext(config));

  assert.equal(result.success, true);
  assert.equal(received, "Outlook");
  assert.deepEqual(result.data, [{ title: "Inbox" }]);
});
