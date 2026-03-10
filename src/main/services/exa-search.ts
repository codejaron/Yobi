import type { AppConfig } from "@shared/types";
import { appLogger as logger } from "@main/runtime/singletons";

type ExaUpstreamTool = "web_search_exa" | "get_code_context_exa";

interface McpSdkModules {
  Client: any;
  StreamableHTTPClientTransport?: any;
  SSEClientTransport?: any;
}

type SearchItemRecord = Record<string, unknown>;

export interface WebSearchItem {
  title: string;
  url: string;
  summary: string;
  content: string;
}

export interface CodeSearchItem {
  title: string;
  url: string;
  snippet: string;
  content: string;
}

interface SearchResponse<TItem> {
  items: TItem[];
  rawText?: string;
  upstreamTool: ExaUpstreamTool;
}

const EXA_ENDPOINT = "https://mcp.exa.ai/mcp?tools=web_search_exa,get_code_context_exa";
const EXA_CONNECT_TIMEOUT_MS = 20_000;
const EXA_TOOL_TIMEOUT_MS = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "未知错误";
}

function resultToText(result: unknown): string {
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

function collectPropertyNames(schema: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const item of schema) {
      collectPropertyNames(item, names);
    }
    return names;
  }

  if (!isRecord(schema)) {
    return names;
  }

  const properties = schema.properties;
  if (isRecord(properties)) {
    for (const key of Object.keys(properties)) {
      names.add(key);
    }
  }

  for (const value of Object.values(schema)) {
    collectPropertyNames(value, names);
  }

  return names;
}

function extractStructuredPayload(result: unknown): unknown {
  if (!isRecord(result)) {
    return null;
  }

  if (result.structuredContent) {
    return result.structuredContent;
  }

  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!isRecord(item)) {
        continue;
      }

      if (item.type === "json" && item.data !== undefined) {
        return item.data;
      }
    }
  }

  return null;
}

function findObjectArrays(value: unknown, depth = 0): SearchItemRecord[][] {
  if (depth > 6) {
    return [];
  }

  if (Array.isArray(value)) {
    const arrays: SearchItemRecord[][] = [];
    const objects = value.filter(isRecord) as SearchItemRecord[];
    if (objects.length > 0 && objects.length === value.length) {
      arrays.push(objects);
    }

    for (const item of value) {
      arrays.push(...findObjectArrays(item, depth + 1));
    }

    return arrays;
  }

  if (!isRecord(value)) {
    return [];
  }

  return Object.values(value).flatMap((child) => findObjectArrays(child, depth + 1));
}

function scoreItemArray(items: SearchItemRecord[], mode: "web" | "code"): number {
  let score = 0;

  for (const item of items.slice(0, 5)) {
    const title = readString(item.title) || readString(item.name) || readString(item.path);
    const url = readString(item.url) || readString(item.href) || readString(item.link);
    const summary =
      readString(item.summary) ||
      readString(item.snippet) ||
      readString(item.description) ||
      readString(item.text);
    const content = readString(item.content) || readString(item.code);

    if (title) {
      score += 2;
    }
    if (url) {
      score += 3;
    }
    if (summary) {
      score += mode === "web" ? 2 : 1;
    }
    if (content) {
      score += mode === "code" ? 3 : 1;
    }
  }

  return score;
}

function pickBestItemArray(result: unknown, mode: "web" | "code"): SearchItemRecord[] {
  const candidates = findObjectArrays(result);
  let best: SearchItemRecord[] = [];
  let bestScore = -1;

  for (const items of candidates) {
    const score = scoreItemArray(items, mode);
    if (score > bestScore) {
      best = items;
      bestScore = score;
    }
  }

  return bestScore > 0 ? best : [];
}

function toWebItem(record: SearchItemRecord): WebSearchItem {
  return {
    title: readString(record.title) || readString(record.name) || readString(record.path) || "未命名结果",
    url: readString(record.url) || readString(record.href) || readString(record.link),
    summary:
      readString(record.summary) ||
      readString(record.snippet) ||
      readString(record.description) ||
      readString(record.text),
    content:
      readString(record.content) ||
      readString(record.text) ||
      readString(record.snippet)
  };
}

function toCodeItem(record: SearchItemRecord): CodeSearchItem {
  return {
    title: readString(record.title) || readString(record.path) || readString(record.name) || "未命名代码结果",
    url: readString(record.url) || readString(record.href) || readString(record.link),
    snippet:
      readString(record.snippet) ||
      readString(record.summary) ||
      readString(record.description) ||
      readString(record.text),
    content:
      readString(record.content) ||
      readString(record.code) ||
      readString(record.text)
  };
}

function normalizeWebSearchResult(result: unknown): SearchResponse<WebSearchItem> {
  const structured = extractStructuredPayload(result) ?? result;
  const items = pickBestItemArray(structured, "web").map((item) => toWebItem(item));
  const rawText = resultToText(result);

  return {
    items,
    rawText: rawText || undefined,
    upstreamTool: "web_search_exa"
  };
}

function normalizeCodeSearchResult(result: unknown): SearchResponse<CodeSearchItem> {
  const structured = extractStructuredPayload(result) ?? result;
  const items = pickBestItemArray(structured, "code").map((item) => toCodeItem(item));
  const rawText = resultToText(result);

  return {
    items,
    rawText: rawText || undefined,
    upstreamTool: "get_code_context_exa"
  };
}

function translateExaError(error: unknown): Error {
  const message = summarizeError(error);
  const normalized = message.toLowerCase();

  if (normalized.includes("429") || normalized.includes("rate limit") || normalized.includes("free mcp rate limit")) {
    return new Error("Exa 免费额度限流，请稍后再试");
  }

  if (normalized.includes("missing") || normalized.includes("not found")) {
    return new Error("Exa 搜索工具暂不可用");
  }

  if (normalized.includes("timeout")) {
    return new Error("Exa 搜索超时，请稍后再试");
  }

  return new Error(message || "Exa 搜索失败");
}

export class ExaSearchService {
  private sdkPromise: Promise<McpSdkModules> | null = null;
  private connectPromise: Promise<any> | null = null;
  private client: any | null = null;
  private availableToolSchemas = new Map<ExaUpstreamTool, unknown>();

  constructor(
    private readonly getConfig: () => AppConfig,
    private readonly options: {
      loadSdk?: () => Promise<McpSdkModules>;
    } = {}
  ) {}

  async searchWeb(query: string): Promise<SearchResponse<WebSearchItem>> {
    const result = await this.callTool("web_search_exa", query);
    return normalizeWebSearchResult(result);
  }

  async searchCode(query: string): Promise<SearchResponse<CodeSearchItem>> {
    const result = await this.callTool("get_code_context_exa", query);
    return normalizeCodeSearchResult(result);
  }

  async dispose(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connectPromise = null;
    this.availableToolSchemas.clear();

    if (!client) {
      return;
    }

    try {
      if (typeof client.close === "function") {
        await client.close();
        return;
      }

      if (typeof client.disconnect === "function") {
        await client.disconnect();
      }
    } catch (error) {
      logger.warn("exa-search", "close-failed", undefined, error);
    }
  }

  private async callTool(toolName: ExaUpstreamTool, query: string): Promise<unknown> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new Error("搜索查询不能为空");
    }

    if (!this.getConfig().tools.exa.enabled) {
      throw new Error("Exa 搜索未启用");
    }

    try {
      const client = await this.ensureConnected();
      const schema = this.availableToolSchemas.get(toolName);
      if (!schema) {
        throw new Error(`missing tool ${toolName}`);
      }

      return await this.withTimeout(
        Promise.resolve(
          client.callTool({
            name: toolName,
            arguments: this.buildArgs(toolName, normalizedQuery, schema)
          })
        ),
        EXA_TOOL_TIMEOUT_MS,
        toolName
      );
    } catch (error) {
      throw translateExaError(error);
    }
  }

  private buildArgs(toolName: ExaUpstreamTool, query: string, schema: unknown): Record<string, unknown> {
    const args: Record<string, unknown> = { query };
    const propertyNames = collectPropertyNames(schema);

    if (toolName === "web_search_exa") {
      for (const candidate of ["numResults", "num_results", "limit", "maxResults"]) {
        if (propertyNames.has(candidate)) {
          args[candidate] = 5;
          break;
        }
      }

      for (const candidate of ["includeContents", "include_contents", "includeText", "include_text"]) {
        if (propertyNames.has(candidate)) {
          args[candidate] = true;
          break;
        }
      }
    }

    return args;
  }

  private async ensureConnected(): Promise<any> {
    if (this.client) {
      return this.client;
    }

    if (!this.connectPromise) {
      this.connectPromise = this.connect();
    }

    try {
      const client = await this.connectPromise;
      this.client = client;
      return client;
    } catch (error) {
      this.connectPromise = null;
      throw error;
    }
  }

  private async connect(): Promise<any> {
    const sdk = await this.loadSdk();
    const client = new sdk.Client({
      name: "yobi-exa-search",
      version: "0.1.0"
    });

    const transport = this.createTransport(sdk);
    await this.withTimeout(client.connect(transport), EXA_CONNECT_TIMEOUT_MS, "connect");

    const listed = await this.withTimeout(Promise.resolve(client.listTools()), 12_000, "list tools");
    const rawTools = Array.isArray((listed as any)?.tools)
      ? (listed as any).tools
      : Array.isArray(listed)
        ? listed
        : [];

    const discovered = new Map<ExaUpstreamTool, unknown>();
    for (const tool of rawTools) {
      if (!isRecord(tool)) {
        continue;
      }

      const name = tool.name;
      if (name !== "web_search_exa" && name !== "get_code_context_exa") {
        continue;
      }

      discovered.set(name, tool.inputSchema ?? tool.parameters ?? {});
    }

    this.availableToolSchemas = discovered;
    if (!this.availableToolSchemas.has("web_search_exa") || !this.availableToolSchemas.has("get_code_context_exa")) {
      throw new Error("Exa MCP 缺少预期工具");
    }

    return client;
  }

  private createTransport(sdk: McpSdkModules): any {
    const url = new URL(EXA_ENDPOINT);

    if (sdk.StreamableHTTPClientTransport) {
      return new sdk.StreamableHTTPClientTransport(url);
    }

    if (sdk.SSEClientTransport) {
      return new sdk.SSEClientTransport(url);
    }

    throw new Error("Remote transport is unavailable in MCP SDK");
  }

  private async loadSdk(): Promise<McpSdkModules> {
    if (this.options.loadSdk) {
      return this.options.loadSdk();
    }

    if (this.sdkPromise) {
      return this.sdkPromise;
    }

    this.sdkPromise = (async () => {
      const clientEntry = "@modelcontextprotocol/sdk/client/index.js";
      const streamableHttpEntry = "@modelcontextprotocol/sdk/client/streamableHttp.js";
      const sseEntry = "@modelcontextprotocol/sdk/client/sse.js";

      const clientModule = await import(clientEntry as string);

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
        reject(new Error(`Exa ${label} timeout (${Math.floor(timeoutMs / 1000)}s)`));
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
