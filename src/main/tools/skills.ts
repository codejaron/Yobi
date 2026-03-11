import { z } from "zod";
import type { ToolDefinition } from "@main/tools/types";
import type { SkillManager } from "@main/skills/manager";

const skillIdSchema = z.object({
  skillId: z.string().min(1)
});

const readSkillResourceSchema = z.object({
  skillId: z.string().min(1),
  relativePath: z.string().min(1)
});

const runSkillScriptSchema = z.object({
  skillId: z.string().min(1),
  relativePath: z.string().min(1),
  args: z.array(z.string()).default([])
});

export function createSkillTools(skillManager: SkillManager): Array<ToolDefinition<any>> {
  const activateSkillTool: ToolDefinition<z.infer<typeof skillIdSchema>> = {
    name: "activate_skill",
    source: "builtin",
    description: "按 skillId 加载完整 SKILL.md，使模型在本轮继续使用该 skill 的指令。",
    parameters: skillIdSchema,
    async execute(params) {
      return {
        success: true,
        data: await skillManager.activateSkill(params.skillId)
      };
    }
  };

  const listResourcesTool: ToolDefinition<z.infer<typeof skillIdSchema>> = {
    name: "list_skill_resources",
    source: "builtin",
    description: "列出某个 skill 下可读取/可执行的资源文件。",
    parameters: skillIdSchema,
    async execute(params) {
      return {
        success: true,
        data: {
          skillId: params.skillId,
          resources: await skillManager.listSkillResources(params.skillId)
        }
      };
    }
  };

  const readResourceTool: ToolDefinition<z.infer<typeof readSkillResourceSchema>> = {
    name: "read_skill_resource",
    source: "builtin",
    description: "读取某个 skill 下已索引的文本资源文件。",
    parameters: readSkillResourceSchema,
    async execute(params) {
      return {
        success: true,
        data: await skillManager.readSkillResource(params.skillId, params.relativePath)
      };
    }
  };

  const runScriptTool: ToolDefinition<z.infer<typeof runSkillScriptSchema>> = {
    name: "run_skill_script",
    source: "builtin",
    description: "执行某个 skill 的 scripts/ 下脚本；始终需要用户审批。",
    parameters: runSkillScriptSchema,
    requiresApproval: () => true,
    approvalText(params) {
      return `运行 skill 脚本: ${params.skillId}/${params.relativePath} ${params.args.join(" ")}`.trim();
    },
    signatureKey(params) {
      return `${params.skillId}:${params.relativePath}:${params.args.join("\u0001")}`;
    },
    async execute(params) {
      const result = await skillManager.runSkillScript(params.skillId, params.relativePath, params.args);
      return result.exitCode === 0
        ? {
            success: true,
            data: result
          }
        : {
            success: false,
            data: result,
            error: result.stderr || `脚本执行失败，退出码 ${result.exitCode}`
          };
    }
  };

  return [activateSkillTool, listResourcesTool, readResourceTool, runScriptTool];
}
