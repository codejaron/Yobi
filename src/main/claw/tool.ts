import { z } from "zod";
import type { ToolDefinition } from "@main/tools/types";
import type { ClawChannel } from "./claw-channel";

const DEFAULT_SESSION_KEY = "main";

export function createClawToolDefinition(channel: ClawChannel): ToolDefinition<{ instruction: string }> {
  return {
    name: "claw",
    source: "builtin",
    description:
      "将操作指令交给 Claw 执行（打开应用、浏览网页、文件操作、命令执行等），并在 Claw 页查看实时进度。",
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
