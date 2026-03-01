import { z } from "zod";
import type { ToolDefinition } from "@main/tools/types";
import type { ClawChannel } from "./claw-channel";

const DEFAULT_SESSION_KEY = "main";

function classifyAction(instruction: string): string {
  const normalized = instruction.toLowerCase();
  if (/\b(open|launch|start)\b/.test(normalized)) {
    return "open";
  }
  if (/\b(search|find|browse|visit|navigate)\b/.test(normalized)) {
    return "browse";
  }
  if (/\b(read|view|inspect|check)\b/.test(normalized)) {
    return "read";
  }
  if (/\b(write|edit|create|save|send)\b/.test(normalized)) {
    return "write";
  }
  if (/\b(run|execute|command|terminal|shell)\b/.test(normalized)) {
    return "run";
  }
  if (/\b(delete|remove|unlink|trash|erase)\b/.test(normalized)) {
    return "delete";
  }
  return "general";
}

function classifyTarget(instruction: string): string {
  const normalized = instruction.toLowerCase();
  const domainMatch = normalized.match(/https?:\/\/([^\s/]+)/);
  if (domainMatch?.[1]) {
    return `domain:${domainMatch[1]}`;
  }

  if (/\b(browser|chrome|safari|firefox|edge)\b/.test(normalized)) {
    return "app:browser";
  }

  if (/\b(mail|email|gmail|outlook)\b/.test(normalized)) {
    return "app:mail";
  }

  if (/\b(file|folder|directory|path|document)\b/.test(normalized)) {
    return "target:file";
  }

  if (/\bterminal|shell|command\b/.test(normalized)) {
    return "target:terminal";
  }

  return "target:general";
}

function classifyRisk(instruction: string): "low" | "medium" | "high" {
  const normalized = instruction.toLowerCase();
  if (/\b(delete|remove|rm\b|sudo|chmod|kill|shutdown|wipe|format)\b/.test(normalized)) {
    return "high";
  }

  if (/\b(write|edit|create|send|run|execute|install|download)\b/.test(normalized)) {
    return "medium";
  }

  return "low";
}

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
      const normalized = instruction.replace(/\s+/g, " ").trim();
      return `${classifyAction(normalized)}|${classifyTarget(normalized)}|${classifyRisk(normalized)}`;
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
