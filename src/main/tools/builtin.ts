import { z } from "zod";
import type { ReminderService } from "@main/services/reminders";
import type { ToolDefinition } from "./types";

export function createBuiltinTools(input: {
  reminderService: ReminderService;
}): Array<ToolDefinition<any>> {
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

  return [reminderTool];
}
