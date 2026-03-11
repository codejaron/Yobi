import { ExaSearchService } from "@main/services/exa-search";
import type { ScheduledTaskService } from "@main/services/scheduled-tasks";
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
}): Array<ToolDefinition<any>> {
  const sandboxGuard = new SandboxGuard(input.getConfig);
  const browserController = new BrowserController();

  return [
    createBrowserTool({
      controller: browserController,
      sandboxGuard,
      getConfig: input.getConfig
    }),
    createSystemTool({
      getConfig: input.getConfig,
      sandboxGuard
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
