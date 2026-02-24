import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { SandboxGuard } from "@main/tools/guard/sandbox";
import type { ToolDefinition, ToolResult } from "@main/tools/types";

const fileParamsSchema = z.object({
  action: z.enum(["read", "write", "append", "list"]),
  targetPath: z.string(),
  content: z.string().optional(),
  recursive: z.boolean().optional()
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
    description: "受控文件读写工具。支持 read/write/append/list，受路径白名单约束。",
    parameters: fileParamsSchema,
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
