import { z } from "zod";
import type { ScheduledTaskService } from "@main/services/scheduled-tasks";
import type { ToolDefinition } from "@main/tools/types";

const scheduleTaskParamsSchema = z.object({
  name: z.string().min(1).optional().describe("任务名称，用于展示和管理。"),
  trigger: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("once").describe("一次性执行。"),
      runAt: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, "执行时间必须是本地时间格式 YYYY-MM-DDTHH:mm[:ss]")
        .describe("本地执行时间，格式 YYYY-MM-DDTHH:mm 或 YYYY-MM-DDTHH:mm:ss。")
    }),
    z.object({
      kind: z.literal("at").describe("一次性执行，等价于 once。"),
      runAt: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, "执行时间必须是本地时间格式 YYYY-MM-DDTHH:mm[:ss]")
        .describe("本地执行时间，格式 YYYY-MM-DDTHH:mm 或 YYYY-MM-DDTHH:mm:ss。")
    }),
    z.object({
      kind: z.literal("cron").describe("按 Cron 周期执行。"),
      expression: z.string().min(1).describe("Cron 表达式，例如 `0 20 * * *` 表示每天 20:00。")
    })
  ]).describe("任务触发方式。"),
  action: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("notify").describe("发送提醒。"),
      text: z.string().min(1).describe("提醒正文。"),
      pushTargets: z
        .object({
          telegram: z.boolean().describe("是否推送到 Telegram。"),
          feishu: z.boolean().describe("是否推送到飞书。")
        })
        .optional()
    }),
    z.object({
      kind: z.literal("agent"),
      prompt: z.string().min(1).describe("Agent 到点后实际执行的任务内容。"),
      pushTargets: z
        .object({
          telegram: z.boolean().describe("是否把 Agent 最终结果推送到 Telegram。"),
          feishu: z.boolean().describe("是否把 Agent 最终结果推送到飞书。")
        })
        .optional(),
      allowedTools: z
        .array(z.enum(["browser", "system", "file", "web_search", "code_search", "web_fetch"]))
        .default([])
        .describe("Agent 运行时允许调用的工具列表。")
    }).describe("Agent 任务。`prompt` 填写 Agent 执行内容。")
  ]).describe("到点后执行的动作。"),
  enabled: z.boolean().optional().describe("是否启用该任务。默认启用。")
});

const taskIdSchema = z.object({
  taskId: z.string().min(1).describe("目标定时任务 ID。")
});

export function createSchedulerTools(input: {
  scheduledTaskService: ScheduledTaskService;
}): Array<ToolDefinition<any>> {
  const scheduleTaskTool: ToolDefinition<z.infer<typeof scheduleTaskParamsSchema>> = {
    name: "schedule_task",
    source: "builtin",
    description: "创建一个一次性或 cron 定时任务，可用于提醒或定时发起完整 Agent 任务。",
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
    description: "列出当前所有定时任务及其当前状态。",
    parameters: z.object({}).describe("无参数。"),
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
    description: "暂停一个已存在的定时任务。",
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
    description: "立即执行一个定时任务，不等待计划时间。",
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
