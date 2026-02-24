import { tool, type ToolSet } from "ai";
import type { AppConfig } from "@shared/types";
import { ApprovalGuard } from "./guard/approval";
import type {
  FunctionSchema,
  ToolDefinition,
  ToolExecutionContext,
  ToolRegistry,
  ToolResult
} from "./types";

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "未知错误";
}

export class DefaultToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<any>>();

  constructor(
    private readonly getConfig: () => AppConfig,
    private readonly approvalGuard: ApprovalGuard
  ) {}

  register(toolDefinition: ToolDefinition<any>): void {
    if (this.tools.has(toolDefinition.name)) {
      throw new Error(`Tool already registered: ${toolDefinition.name}`);
    }

    this.tools.set(toolDefinition.name, toolDefinition);
  }

  list(): ToolDefinition<any>[] {
    return [...this.tools.values()];
  }

  getSchemas(): FunctionSchema[] {
    return this.list().map((item) => ({
      name: item.name,
      description: item.description,
      parameters: item.parameters
    }));
  }

  getToolSet(context: Omit<ToolExecutionContext, "getConfig">): ToolSet {
    const toolSet: Record<string, unknown> = {};

    for (const definition of this.tools.values()) {
      if (!this.isToolEnabled(definition.name)) {
        continue;
      }

      toolSet[definition.name] = tool({
        description: definition.description,
        inputSchema: definition.parameters,
        execute: async (input) =>
          this.execute(definition.name, input as Record<string, unknown>, context)
      });
    }

    return toolSet as ToolSet;
  }

  async execute(
    name: string,
    params: Record<string, unknown>,
    context: Omit<ToolExecutionContext, "getConfig">
  ): Promise<ToolResult> {
    const definition = this.tools.get(name);
    if (!definition) {
      return {
        success: false,
        error: `未注册工具: ${name}`
      };
    }

    const parsed = definition.parameters.safeParse(params);
    if (!parsed.success) {
      return {
        success: false,
        error: `参数校验失败: ${parsed.error.issues
          .map((item) => `${item.path.join(".") || "(root)"}: ${item.message}`)
          .join("; ")}`
      };
    }

    const input = parsed.data;
    const description = definition.approvalText?.(input) ?? `${name} ${JSON.stringify(input)}`;
    const signature = `${name}:${JSON.stringify(input)}`;

    const needsApproval = definition.requiresApproval?.(input) ?? false;
    if (needsApproval) {
      const approved = await this.approvalGuard.ensureApproved({
        toolName: name,
        params: input,
        description,
        signature
      }, context.requestApproval);

      if (!approved) {
        return {
          success: false,
          error: "用户拒绝了该操作"
        };
      }
    }

    try {
      return await definition.execute(input, {
        ...context,
        getConfig: this.getConfig
      });
    } catch (error) {
      return {
        success: false,
        error: summarizeError(error)
      };
    }
  }

  async dispose(): Promise<void> {
    for (const definition of this.tools.values()) {
      if (definition.dispose) {
        await definition.dispose();
      }
    }
  }

  private isToolEnabled(name: string): boolean {
    const config = this.getConfig();

    if (name === "browser") {
      return config.tools.browser.enabled;
    }

    if (name === "system") {
      return config.tools.system.enabled;
    }

    if (name === "file") {
      return config.tools.file.readEnabled || config.tools.file.writeEnabled;
    }

    return true;
  }
}
