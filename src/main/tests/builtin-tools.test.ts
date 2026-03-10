import test from "node:test";
import assert from "node:assert/strict";
import { createBuiltinTools } from "../tools/builtin.js";
import { DEFAULT_CONFIG, type AppConfig } from "@shared/types";

function cloneConfig(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

test("createBuiltinTools: registers native tools and Exa tools", () => {
  const config = cloneConfig();
  const builtins = createBuiltinTools({
    reminderService: {
      create: async () => null
    } as any,
    getConfig: () => config,
    exaSearchService: {
      searchWeb: async () => ({ items: [], upstreamTool: "web_search_exa" }),
      searchCode: async () => ({ items: [], upstreamTool: "get_code_context_exa" }),
      dispose: async () => undefined
    } as any
  });

  const toolNames = builtins.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, ["browser", "code_search", "file", "reminder", "system", "web_search"]);
});
