import { z } from "zod";
import type { ToolDefinition } from "@main/tools/types";
import type { ClawChannel } from "./claw-channel";

const DEFAULT_SESSION_KEY = "main";

export function createClawToolDefinition(channel: ClawChannel): ToolDefinition<{ instruction: string }> {
  return {
    name: "claw",
    source: "builtin",
    description:
      "Claw 是一个运行在用户电脑上的自主 agent，能操作浏览器、执行终端命令、读写文件、搜索网页，并自主规划多步任务。将自然语言指令交给 Claw，它会自行拆解并完成。",
    parameters: z.object({
      instruction: z.string().min(1)
    }),
    isEnabled: (config) => config.openclaw.enabled,
    requiresApproval: (_params, config) => config.openclaw.approvalRequired,
    approvalText: ({ instruction }) => `Claw 执行：${instruction.trim()}`,
    signatureKey: ({ instruction }) => {
      return instruction.replace(/\s+/g, " ").trim().toLowerCase();
    },
    execute: async ({ instruction }) => {
      try {
        await channel.sendFromYobi(DEFAULT_SESSION_KEY, instruction);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Claw 当前不可用"
        };
      }

      return {
        success: true,
        data: "已让 Claw 去处理了，你可以切到 Claw 查看进度。"
      };
    }
  };
}
