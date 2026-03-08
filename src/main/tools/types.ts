import type { ToolSet } from "ai";
import type { z } from "zod";
import type { AppConfig, CommandApprovalDecision } from "@shared/types";

interface ToolMediaAttachment {
  type: "image" | "file";
  path: string;
  mimeType: string;
}

type ToolApprovalDecision = CommandApprovalDecision;

export interface ToolApprovalRequest {
  toolName: string;
  params: Record<string, unknown>;
  description: string;
  signature: string;
}

export type ToolApprovalHandler = (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  media?: ToolMediaAttachment[];
}

export interface ToolExecutionContext {
  channel: "telegram" | "console" | "qq" | "feishu";
  userMessage: string;
  getConfig: () => AppConfig;
  requestApproval?: ToolApprovalHandler;
}

export interface ToolDefinition<TInput extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: z.ZodType<TInput>;
  source?: "builtin" | "mcp";
  isEnabled?: (config: AppConfig) => boolean;
  requiresApproval?: (params: TInput, config: AppConfig) => boolean;
  approvalText?: (params: TInput) => string;
  signatureKey?: (params: TInput) => string;
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
  unregisterBySource(source: NonNullable<ToolDefinition["source"]>): Promise<void>;
  list(): ToolDefinition<any>[];
  getSchemas(): FunctionSchema[];
  getToolSet(context: Omit<ToolExecutionContext, "getConfig">): ToolSet;
  execute(
    name: string,
    params: Record<string, unknown>,
    context: Omit<ToolExecutionContext, "getConfig">
  ): Promise<ToolResult>;
  dispose(): Promise<void>;
}
