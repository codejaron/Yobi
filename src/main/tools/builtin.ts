import { z } from "zod";
import type { ReminderService } from "@main/services/reminders";
import { ExaSearchService } from "@main/services/exa-search";
import { createBrowserTool } from "@main/tools/browser/browser-tool";
import { BrowserController } from "@main/tools/browser/controller";
import { createExaTools } from "@main/tools/exa";
import { createFileTool } from "@main/tools/file/file-tool";
import { SandboxGuard } from "@main/tools/guard/sandbox";
import { createSystemTool } from "@main/tools/system/system-tool";
import type { AppConfig } from "@shared/types";
import type { ToolDefinition } from "./types";

export function createBuiltinTools(input: {
  reminderService: ReminderService;
  getConfig: () => AppConfig;
  exaSearchService: ExaSearchService;
}): Array<ToolDefinition<any>> {
  const sandboxGuard = new SandboxGuard(input.getConfig);
  const browserController = new BrowserController();

  const reminderTool: ToolDefinition<{ time: string; text: string }> = {
    name: "reminder",
    source: "builtin",
    description: "创建一个定时提醒",
    parameters: z.object({
      time: z.string().min(1),
      text: z.string().min(1)
    }),
    execute: async ({ time, text }) => {
      const item = await input.reminderService.create({
        at: time,
        text
      });

      if (!item) {
        return {
          success: false,
          error: "提醒时间格式不合法"
        };
      }

      return {
        success: true,
        data: {
          id: item.id,
          at: item.at,
          text: item.text
        }
      };
    }
  };

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
    reminderTool
  ];
}
