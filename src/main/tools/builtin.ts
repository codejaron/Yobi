import { ExaSearchService } from "@main/services/exa-search";
import { ChatMediaStore } from "@main/services/chat-media";
import type { ScheduledTaskService } from "@main/services/scheduled-tasks";
import type { CompanionPaths } from "@main/storage/paths";
import { createBrowserTool } from "@main/tools/browser/browser-tool";
import { BrowserController } from "@main/tools/browser/controller";
import { createExaTools } from "@main/tools/exa";
import { createFileTool } from "@main/tools/file/file-tool";
import { SandboxGuard } from "@main/tools/guard/sandbox";
import { createSchedulerTools } from "@main/tools/scheduler";
import { createSystemTool } from "@main/tools/system/system-tool";
import type { AppConfig } from "@shared/types";
import type { ToolDefinition } from "./types";

export function createBuiltinTools(input: {
  getConfig: () => AppConfig;
  exaSearchService: ExaSearchService;
  scheduledTaskService: ScheduledTaskService;
  paths: CompanionPaths;
}): Array<ToolDefinition<any>> {
  const chatMediaStore = new ChatMediaStore(input.paths);
  const sandboxGuard = new SandboxGuard(input.getConfig, chatMediaStore.getReadRoots());
  const browserController = new BrowserController();

  return [
    createBrowserTool({
      controller: browserController,
      sandboxGuard,
      getConfig: input.getConfig,
      chatMediaStore
    }),
    createSystemTool({
      getConfig: input.getConfig,
      sandboxGuard,
      chatMediaStore
    }),
    createFileTool({
      sandboxGuard
    }),
    ...createExaTools({
      exaSearchService: input.exaSearchService
    }),
    ...createSchedulerTools({
      scheduledTaskService: input.scheduledTaskService
    })
  ];
}
