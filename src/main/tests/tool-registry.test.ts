import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { DEFAULT_CONFIG, type AppConfig } from "@shared/types";
import { DefaultToolRegistry } from "../tools/registry.js";

function cloneConfig(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

test("DefaultToolRegistry: getToolSet respects allowedToolNames", () => {
  const config = cloneConfig();
  const registry = new DefaultToolRegistry(
    () => config,
    {
      ensureApproved: async () => true
    } as any
  );

  registry.register({
    name: "web_search",
    source: "builtin",
    description: "search",
    parameters: z.object({}),
    execute: async () => ({ success: true })
  });
  registry.register({
    name: "system",
    source: "builtin",
    description: "system",
    parameters: z.object({}),
    execute: async () => ({ success: true })
  });

  const toolSet = registry.getToolSet({
    channel: "console",
    userMessage: "hi",
    allowedToolNames: ["web_search"]
  });

  assert.deepEqual(Object.keys(toolSet), ["web_search"]);
});

test("DefaultToolRegistry: getToolSet forwards toModelOutput", () => {
  const config = cloneConfig();
  const registry = new DefaultToolRegistry(
    () => config,
    {
      ensureApproved: async () => true
    } as any
  );

  registry.register({
    name: "browser",
    source: "builtin",
    description: "browser",
    parameters: z.object({}),
    execute: async () => ({ success: true }),
    toModelOutput: (result) => ({
      type: "text",
      value: result.success ? "ok" : "failed"
    })
  });

  const toolSet = registry.getToolSet({
    channel: "console",
    userMessage: "hi"
  });

  assert.equal(typeof (toolSet.browser as any)?.toModelOutput, "function");
  assert.deepEqual((toolSet.browser as any).toModelOutput({ success: true }), {
    type: "text",
    value: "ok"
  });
});

test("DefaultToolRegistry: execute blocks unauthorized tools and skips approval for preapproved tools", async () => {
  const config = cloneConfig();
  let approvalCalls = 0;
  let executeCalls = 0;
  const registry = new DefaultToolRegistry(
    () => config,
    {
      ensureApproved: async () => {
        approvalCalls += 1;
        return true;
      }
    } as any
  );

  registry.register({
    name: "system",
    source: "builtin",
    description: "system",
    parameters: z.object({}),
    requiresApproval: () => true,
    execute: async () => {
      executeCalls += 1;
      return { success: true };
    }
  });

  const blocked = await registry.execute(
    "system",
    {},
    {
      channel: "console",
      userMessage: "hi",
      allowedToolNames: ["web_search"]
    }
  );
  assert.equal(blocked.success, false);
  assert.match(blocked.error ?? "", /未授权使用工具/);

  const preapproved = await registry.execute(
    "system",
    {},
    {
      channel: "console",
      userMessage: "hi",
      allowedToolNames: ["system"],
      preapprovedToolNames: ["system"]
    }
  );
  assert.equal(preapproved.success, true);
  assert.equal(approvalCalls, 0);
  assert.equal(executeCalls, 1);

  const approvedNormally = await registry.execute(
    "system",
    {},
    {
      channel: "console",
      userMessage: "hi",
      allowedToolNames: ["system"]
    }
  );
  assert.equal(approvedNormally.success, true);
  assert.equal(approvalCalls, 1);
  assert.equal(executeCalls, 2);
});
