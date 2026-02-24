import type { ToolSet } from "ai";
import type { z } from "zod";
import type { ActivitySnapshot, AppConfig } from "@shared/types";

export interface ToolMediaAttachment {
  type: "image" | "file";
  path: string;
  mimeType: string;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  media?: ToolMediaAttachment[];
}

export interface ToolExecutionContext {
  channel: "telegram" | "system";
  userMessage: string;
  activity: ActivitySnapshot | null;
  getConfig: () => AppConfig;
}

export interface ToolDefinition<TInput extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: z.ZodType<TInput>;
  requiresApproval?: (params: TInput) => boolean;
  approvalText?: (params: TInput) => string;
  execute(params: TInput, context: ToolExecutionContext): Promise<ToolResult>;
  dispose?: () => Promise<void>;
}

export interface FunctionSchema {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ToolRegistry {
  register(tool: ToolDefinition<any>): void;
  list(): ToolDefinition<any>[];
  getSchemas(): FunctionSchema[];
  getToolSet(
    context: Omit<ToolExecutionContext, "getConfig">
  ): ToolSet;
  execute(
    name: string,
    params: Record<string, unknown>,
    context: Omit<ToolExecutionContext, "getConfig">
  ): Promise<ToolResult>;
  dispose(): Promise<void>;
}
