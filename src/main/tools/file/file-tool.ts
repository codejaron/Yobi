import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { SandboxGuard } from "@main/tools/guard/sandbox";
import type { ToolDefinition, ToolResult } from "@main/tools/types";

const fileParamsSchema = z.object({
  action: z.enum(["read", "write", "append", "list"]).describe("文件操作类型。"),
  targetPath: z.string().describe("目标文件或目录路径。"),
  content: z.string().optional().describe("写入或追加时使用的文本内容。"),
  recursive: z.boolean().optional().describe("list 时是否递归列出子目录。")
});

type FileParams = z.infer<typeof fileParamsSchema>;

interface FileToolDeps {
  sandboxGuard: SandboxGuard;
}

function trimText(value: string, limit = 16_000): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}\n...[truncated]`;
}

export function createFileTool(deps: FileToolDeps): ToolDefinition<FileParams> {
  return {
    name: "file",
    source: "builtin",
    description: "受控文件工具。支持读取文件、列目录、写入文件、追加文件，受路径白名单约束。",
    parameters: fileParamsSchema,
    isEnabled: (config) => config.tools.file.readEnabled || config.tools.file.writeEnabled,
    requiresApproval(params) {
      return params.action === "write" || params.action === "append";
    },
    approvalText(params) {
      return `${params.action} 文件: ${params.targetPath}`;
    },
    async execute(params): Promise<ToolResult> {
      if (params.action === "read") {
        const resolved = deps.sandboxGuard.ensureFileReadAllowed(params.targetPath);
        const buffer = await readFile(resolved);

        return {
          success: true,
          data: {
            path: resolved,
            content: trimText(buffer.toString("utf-8"))
          }
        };
      }

      if (params.action === "list") {
        const resolved = deps.sandboxGuard.ensureFileReadAllowed(params.targetPath);
        const entries = await readdir(resolved, {
          withFileTypes: true,
          recursive: params.recursive ?? false
        } as any);

        const normalized = entries.slice(0, 400).map((entry: any) => ({
          name: entry.name,
          type: entry.isDirectory() ? "dir" : "file"
        }));

        return {
          success: true,
          data: {
            path: resolved,
            entries: normalized,
            total: normalized.length
          }
        };
      }

      const resolved = deps.sandboxGuard.ensureFileWriteAllowed(params.targetPath);
      const parentDir = path.dirname(resolved);
      await mkdir(parentDir, { recursive: true });

      if (params.action === "write") {
        await writeFile(resolved, params.content ?? "", "utf-8");
      } else {
        await appendFile(resolved, params.content ?? "", "utf-8");
      }

      const fileStat = await stat(resolved);

      return {
        success: true,
        data: {
          path: resolved,
          size: fileStat.size,
          updatedAt: fileStat.mtime.toISOString()
        }
      };
    }
  };
}
