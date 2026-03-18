import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, type AppConfig } from "@shared/types";
import { createSystemTool } from "@main/tools/system/system-tool";

function cloneConfig(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function createTool(config: AppConfig) {
  return createSystemTool({
    getConfig: () => config,
    sandboxGuard: {
      ensureExecAllowed: () => undefined
    } as any,
    chatMediaStore: {
      storeToolMedia: async () => ({
        id: "attachment-1",
        kind: "image",
        filename: "system-screenshot.png",
        mimeType: "image/png",
        size: 1,
        path: "/tmp/system-screenshot.png",
        source: "tool-generated",
        createdAt: new Date().toISOString()
      })
    } as any
  });
}

test("createSystemTool: approvalRequired=true keeps high-risk actions gated", () => {
  const config = cloneConfig();
  config.tools.system.enabled = true;
  config.tools.system.approvalRequired = true;
  const tool = createTool(config);

  assert.equal(tool.requiresApproval?.({ action: "exec" } as any, config), true);
  assert.equal(tool.requiresApproval?.({ action: "open_app" } as any, config), true);
  assert.equal(tool.requiresApproval?.({ action: "type_text" } as any, config), true);
  assert.equal(tool.requiresApproval?.({ action: "press_keys" } as any, config), true);
  assert.equal(tool.requiresApproval?.({ action: "screenshot_app" } as any, config), true);
  assert.equal(tool.requiresApproval?.({ action: "notify" } as any, config), false);
  assert.equal(tool.requiresApproval?.({ action: "get_windows" } as any, config), false);
});

test("createSystemTool: approvalRequired=false disables system approvals while keeping safe actions unapproved", () => {
  const config = cloneConfig();
  config.tools.system.enabled = true;
  config.tools.system.approvalRequired = false;
  const tool = createTool(config);

  assert.equal(tool.requiresApproval?.({ action: "exec" } as any, config), false);
  assert.equal(tool.requiresApproval?.({ action: "open_app" } as any, config), false);
  assert.equal(tool.requiresApproval?.({ action: "type_text" } as any, config), false);
  assert.equal(tool.requiresApproval?.({ action: "press_keys" } as any, config), false);
  assert.equal(tool.requiresApproval?.({ action: "screenshot_app" } as any, config), false);
  assert.equal(tool.requiresApproval?.({ action: "notify" } as any, config), false);
  assert.equal(tool.requiresApproval?.({ action: "get_windows" } as any, config), false);
});
