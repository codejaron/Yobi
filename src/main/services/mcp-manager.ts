import { z } from "zod";
import type { AppConfig, McpServerConfig } from "@shared/types";
import type { ToolDefinition, ToolRegistry } from "@main/tools/types";
import { appLogger as logger } from "@main/runtime/singletons";

interface McpSdkModules {
  Client: any;
  StdioClientTransport?: any;
  StreamableHTTPClientTransport?: any;
  SSEClientTransport?: any;
}

interface RegisteredMcpTool {
  runtimeName: string;
  serverId: string;
  serverLabel: string;
  originalName: string;
  description: string;
  inputSchema?: unknown;
}

interface McpServerConnection {
  config: McpServerConfig;
  client: any;
  tools: RegisteredMcpTool[];
}

function normalizeSegment(input: string): string {
  return input
    .trim()
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function toRuntimeToolName(serverId: string, toolName: string): string {
  const normalizedServerId = normalizeSegment(serverId) || "server";
  const normalizedToolName = normalizeSegment(toolName) || "tool";
  return `mcp_${normalizedServerId}__${normalizedToolName}`;
}

function describeInputSchema(schema: unknown): string {
  if (!schema || typeof schema !== "object") {
    return "";
  }

  try {
    const text = JSON.stringify(schema);
    if (!text) {
      return "";
    }

    return text.length > 480 ? `${text.slice(0, 480)}...` : text;
  } catch {
    return "";
  }
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "未知错误";
}

export class McpManager {
  private sdkPromise: Promise<McpSdkModules> | null = null;
  private servers = new Map<string, McpServerConnection>();

  constructor(private readonly getConfig: () => AppConfig) {}

  async init(registry: ToolRegistry): Promise<void> {
    await this.dispose();

    const config = this.getConfig();
    for (const server of config.tools.mcp.servers) {
      if (!server.enabled) {
        continue;
      }

      if (this.servers.has(server.id)) {
        logger.warn("mcp", "duplicate-server-id", { serverId: server.id });
        continue;
      }

      let connection: McpServerConnection | null = null;
      try {
        connection = await this.connectServer(server);
        for (const tool of connection.tools) {
          registry.register(this.createToolDefinition(tool));
        }
        this.servers.set(server.id, connection);
      } catch (error) {
        if (connection) {
          await this.disconnectClient(connection.client);
        }
        logger.warn("mcp", "connect-server-failed", { serverId: server.id }, error);
      }
    }
  }

  async dispose(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const connection of this.servers.values()) {
      pending.push(this.disconnectClient(connection.client));
    }

    await Promise.all(pending);
    this.servers.clear();
  }

  async callServerTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const connection = this.servers.get(serverId);
    if (!connection) {
      throw new Error(`MCP server not connected: ${serverId}`);
    }

    const exists = connection.tools.some((tool) => tool.originalName === toolName);
    if (!exists) {
      throw new Error(`MCP tool not found on ${serverId}: ${toolName}`);
    }

    return this.callClientTool(connection.client, toolName, args);
  }

  resultToText(result: unknown): string {
    if (typeof result === "string") {
      return result.trim();
    }

    if (!result || typeof result !== "object") {
      return "";
    }

    const payload = result as Record<string, unknown>;
    const content = payload.content;
    if (Array.isArray(content)) {
      const chunks = content
        .map((item) => {
          if (!item || typeof item !== "object") {
            return "";
          }

          const part = item as Record<string, unknown>;
          if (typeof part.text === "string") {
            return part.text.trim();
          }

          if (part.type === "json" && part.data) {
            try {
              return JSON.stringify(part.data);
            } catch {
              return "";
            }
          }

          return "";
        })
        .filter(Boolean);

      if (chunks.length > 0) {
        return chunks.join("\n");
      }
    }

    if (typeof payload.structuredContent === "string") {
      return payload.structuredContent.trim();
    }

    if (payload.structuredContent && typeof payload.structuredContent === "object") {
      try {
        return JSON.stringify(payload.structuredContent);
      } catch {
        return "";
      }
    }

    if (typeof payload.text === "string") {
      return payload.text.trim();
    }

    try {
      return JSON.stringify(payload);
    } catch {
      return "";
    }
  }

  private async connectServer(server: McpServerConfig): Promise<McpServerConnection> {
    const sdk = await this.loadSdk();
    const transport = this.createTransport(sdk, server);
    const client = new sdk.Client({
      name: "yobi",
      version: "0.1.0"
    });

    await this.withTimeout(client.connect(transport), 20_000, `connect ${server.id}`);

    const listed = await this.withTimeout(
      Promise.resolve(client.listTools()),
      12_000,
      `list tools ${server.id}`
    );

    const rawTools = Array.isArray((listed as any)?.tools)
      ? (listed as any).tools
      : Array.isArray(listed)
        ? listed
        : [];

    const tools: RegisteredMcpTool[] = rawTools
      .filter((tool: unknown): tool is Record<string, unknown> => !!tool && typeof tool === "object")
      .map((tool: Record<string, unknown>) => {
        const originalName = typeof tool.name === "string" ? tool.name : "";
        if (!originalName) {
          return null;
        }

        return {
          runtimeName: toRuntimeToolName(server.id, originalName),
          serverId: server.id,
          serverLabel: server.label,
          originalName,
          description:
            typeof tool.description === "string" ? tool.description : `MCP tool ${originalName}`,
          inputSchema: tool.inputSchema ?? tool.parameters
        };
      })
      .filter((tool: RegisteredMcpTool | null): tool is RegisteredMcpTool => tool !== null);

    return {
      config: server,
      client,
      tools
    };
  }

  private createToolDefinition(tool: RegisteredMcpTool): ToolDefinition<Record<string, unknown>> {
    const schemaHint = describeInputSchema(tool.inputSchema);
    const description = schemaHint
      ? `[MCP:${tool.serverLabel}] ${tool.description}\n输入参数 JSON Schema: ${schemaHint}`
      : `[MCP:${tool.serverLabel}] ${tool.description}`;

    return {
      name: tool.runtimeName,
      source: "mcp",
      description,
      parameters: z.object({}).passthrough(),
      approvalText: (params) =>
        `MCP ${tool.serverLabel}/${tool.originalName} ${JSON.stringify(params)}`,
      execute: async (params) => {
        const connection = this.servers.get(tool.serverId);
        if (!connection) {
          return {
            success: false,
            error: `MCP server offline: ${tool.serverId}`
          };
        }

        try {
          const data = await this.callClientTool(connection.client, tool.originalName, params);
          return {
            success: true,
            data
          };
        } catch (error) {
          return {
            success: false,
            error: summarizeError(error)
          };
        }
      }
    };
  }

  private async callClientTool(
    client: any,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    return this.withTimeout(
      Promise.resolve(client.callTool({
        name: toolName,
        arguments: args
      })),
      20_000,
      `call tool ${toolName}`
    );
  }

  private async disconnectClient(client: any): Promise<void> {
    try {
      if (typeof client.close === "function") {
        await client.close();
        return;
      }

      if (typeof client.disconnect === "function") {
        await client.disconnect();
      }
    } catch (error) {
      logger.warn("mcp", "close-failed", undefined, error);
    }
  }

  private createTransport(sdk: McpSdkModules, server: McpServerConfig): any {
    if (server.transport === "stdio") {
      if (!sdk.StdioClientTransport) {
        throw new Error("Stdio transport is unavailable in MCP SDK");
      }

      return new sdk.StdioClientTransport({
        command: server.command,
        args: server.args,
        env: {
          ...process.env,
          ...server.env
        }
      });
    }

    const url = new URL(server.url);
    const requestInit = Object.keys(server.headers).length > 0
      ? {
          headers: server.headers
        }
      : undefined;

    if (sdk.StreamableHTTPClientTransport) {
      return new sdk.StreamableHTTPClientTransport(url, {
        requestInit
      });
    }

    if (sdk.SSEClientTransport) {
      return new sdk.SSEClientTransport(url, {
        requestInit
      });
    }

    throw new Error("Remote transport is unavailable in MCP SDK");
  }

  private async loadSdk(): Promise<McpSdkModules> {
    if (this.sdkPromise) {
      return this.sdkPromise;
    }

    this.sdkPromise = (async () => {
      const clientEntry = "@modelcontextprotocol/sdk/client/index.js";
      const stdioEntry = "@modelcontextprotocol/sdk/client/stdio.js";
      const streamableHttpEntry = "@modelcontextprotocol/sdk/client/streamableHttp.js";
      const sseEntry = "@modelcontextprotocol/sdk/client/sse.js";

      const clientModule = await import(clientEntry as string);
      const stdioModule = await import(stdioEntry as string);

      let streamableHttpModule: Record<string, unknown> | null = null;
      try {
        streamableHttpModule = (await import(streamableHttpEntry as string)) as Record<string, unknown>;
      } catch {
        streamableHttpModule = null;
      }

      let sseModule: Record<string, unknown> | null = null;
      if (!streamableHttpModule) {
        try {
          sseModule = (await import(sseEntry as string)) as Record<string, unknown>;
        } catch {
          sseModule = null;
        }
      }

      return {
        Client: (clientModule as any).Client,
        StdioClientTransport: (stdioModule as any).StdioClientTransport,
        StreamableHTTPClientTransport: streamableHttpModule
          ? (streamableHttpModule as any).StreamableHTTPClientTransport
          : undefined,
        SSEClientTransport: sseModule ? (sseModule as any).SSEClientTransport : undefined
      };
    })();

    return this.sdkPromise;
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`MCP ${label} timeout (${Math.floor(timeoutMs / 1000)}s)`));
      }, timeoutMs);

      promise
        .then((value) => resolve(value))
        .catch((error) => reject(error))
        .finally(() => {
          clearTimeout(timer);
        });
    });
  }
}
