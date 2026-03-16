import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createBuiltinTools } from "../tools/builtin.js";
import { CompanionPaths } from "../storage/paths.js";
import { DEFAULT_CONFIG, type AppConfig } from "@shared/types";

function cloneConfig(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

test("createBuiltinTools: registers native tools and Exa tools", async () => {
  const config = cloneConfig();
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "yobi-builtins-"));
  const paths = new CompanionPaths(baseDir);
  paths.ensureLayout();
  try {
    const builtins = createBuiltinTools({
      getConfig: () => config,
      exaSearchService: {
        searchWeb: async () => ({ items: [], upstreamTool: "web_search_exa" }),
        searchCode: async () => ({ items: [], upstreamTool: "get_code_context_exa" }),
        fetchWeb: async () => ({ items: [], upstreamTool: "crawling_exa" }),
        dispose: async () => undefined
      } as any,
      scheduledTaskService: {
        saveTask: async () => ({ id: "task-1" }),
        listTasks: () => [],
        pauseTask: async () => ({ id: "task-1" }),
        resumeTask: async () => ({ id: "task-1" }),
        deleteTask: async () => ({ removed: true }),
        runTaskNow: async () => ({ id: "run-1" })
      } as any,
      paths
    });

    const toolNames = builtins.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, [
      "browser",
      "cancel_scheduled_task",
      "code_search",
      "file",
      "list_scheduled_tasks",
      "pause_scheduled_task",
      "resume_scheduled_task",
      "run_scheduled_task_now",
      "schedule_task",
      "system",
      "web_fetch",
      "web_search"
    ]);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});
