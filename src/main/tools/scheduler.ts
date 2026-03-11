import { z } from "zod";
import type { ScheduledTaskService } from "@main/services/scheduled-tasks";
import type { ToolDefinition } from "@main/tools/types";

const scheduleTaskParamsSchema = z.object({
  name: z.string().min(1).optional(),
  trigger: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("once"),
      runAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, "执行时间必须是本地时间格式 YYYY-MM-DDTHH:mm[:ss]")
    }),
    z.object({
      kind: z.literal("at"),
      runAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, "执行时间必须是本地时间格式 YYYY-MM-DDTHH:mm[:ss]")
    }),
    z.object({
      kind: z.literal("cron"),
      expression: z.string().min(1)
    })
  ]),
  action: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("notify"),
      text: z.string().min(1),
      pushTargets: z
        .object({
          telegram: z.boolean(),
          feishu: z.boolean()
        })
        .optional()
    }),
    z.object({
      kind: z.literal("tool"),
      toolName: z.enum(["browser", "system", "file", "web_search", "code_search", "web_fetch"]),
      params: z.record(z.string(), z.unknown())
    })
  ]),
  enabled: z.boolean().optional()
});

const taskIdSchema = z.object({
  taskId: z.string().min(1)
});

export function createSchedulerTools(input: {
  scheduledTaskService: ScheduledTaskService;
}): Array<ToolDefinition<any>> {
  const scheduleTaskTool: ToolDefinition<z.infer<typeof scheduleTaskParamsSchema>> = {
    name: "schedule_task",
    source: "builtin",
    description: "创建一个一次性或 cron 定时任务，可用于提醒或定时执行工具。",
    parameters: scheduleTaskParamsSchema,
    async execute(params, context) {
      const task = await input.scheduledTaskService.saveTask(
        {
          name: params.name,
          trigger:
            params.trigger.kind === "cron"
              ? {
                  kind: "cron",
                  expression: params.trigger.expression,
                  timezone: "local"
                }
              : {
                  kind: "once",
                  runAt: params.trigger.runAt
                },
          action: params.action,
          enabled: params.enabled
        },
        {
          requestApproval: context.requestApproval
        }
      );

      return {
        success: true,
        data: task
      };
    }
  };

  const listTool: ToolDefinition<Record<string, never>> = {
    name: "list_scheduled_tasks",
    source: "builtin",
    description: "列出当前所有定时任务。",
    parameters: z.object({}),
    async execute() {
      return {
        success: true,
        data: {
          tasks: input.scheduledTaskService.listTasks()
        }
      };
    }
  };

  const pauseTool: ToolDefinition<z.infer<typeof taskIdSchema>> = {
    name: "pause_scheduled_task",
    source: "builtin",
    description: "暂停一个定时任务。",
    parameters: taskIdSchema,
    async execute({ taskId }) {
      return {
        success: true,
        data: await input.scheduledTaskService.pauseTask(taskId)
      };
    }
  };

  const resumeTool: ToolDefinition<z.infer<typeof taskIdSchema>> = {
    name: "resume_scheduled_task",
    source: "builtin",
    description: "恢复一个已暂停的定时任务。",
    parameters: taskIdSchema,
    async execute({ taskId }) {
      return {
        success: true,
        data: await input.scheduledTaskService.resumeTask(taskId)
      };
    }
  };

  const cancelTool: ToolDefinition<z.infer<typeof taskIdSchema>> = {
    name: "cancel_scheduled_task",
    source: "builtin",
    description: "删除一个定时任务。",
    parameters: taskIdSchema,
    async execute({ taskId }) {
      return {
        success: true,
        data: await input.scheduledTaskService.deleteTask(taskId)
      };
    }
  };

  const runNowTool: ToolDefinition<z.infer<typeof taskIdSchema>> = {
    name: "run_scheduled_task_now",
    source: "builtin",
    description: "立即执行一个定时任务。",
    parameters: taskIdSchema,
    async execute({ taskId }) {
      return {
        success: true,
        data: await input.scheduledTaskService.runTaskNow(taskId)
      };
    }
  };

  return [scheduleTaskTool, listTool, pauseTool, resumeTool, cancelTool, runNowTool];
}
