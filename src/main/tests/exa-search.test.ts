import test from "node:test";
import assert from "node:assert/strict";
import { ExaSearchService } from "../services/exa-search.js";
import { DEFAULT_CONFIG, type AppConfig } from "@shared/types";

function cloneConfig(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

test("ExaSearchService: maps web search results and injects supported params", async () => {
  const config = cloneConfig();
  let toolCallArgs: Record<string, unknown> | null = null;

  class FakeClient {
    async connect(): Promise<void> {}

    async listTools(): Promise<unknown> {
      return {
        tools: [
          {
            name: "web_search_exa",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
                numResults: { type: "number" },
                includeContents: { type: "boolean" }
              }
            }
          },
          {
            name: "get_code_context_exa",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" }
              }
            }
          }
        ]
      };
    }

    async callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<unknown> {
      toolCallArgs = input.arguments;
      return {
        structuredContent: {
          results: [
            {
              title: "Yobi",
              url: "https://example.com/yobi",
              summary: "summary",
              content: "content"
            }
          ]
        }
      };
    }

    async close(): Promise<void> {}
  }

  const service = new ExaSearchService(() => config, {
    loadSdk: async () => ({
      Client: FakeClient,
      StreamableHTTPClientTransport: class {}
    })
  });

  const result = await service.searchWeb("yobi");

  assert.deepEqual(toolCallArgs, {
    query: "yobi",
    numResults: 5,
    includeContents: true
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.title, "Yobi");
  assert.equal(result.items[0]?.url, "https://example.com/yobi");
  assert.equal(result.items[0]?.summary, "summary");
  assert.equal(result.items[0]?.content, "content");
  await service.dispose();
});

test("ExaSearchService: maps code search results", async () => {
  const config = cloneConfig();

  class FakeClient {
    async connect(): Promise<void> {}

    async listTools(): Promise<unknown> {
      return {
        tools: [
          {
            name: "web_search_exa",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" }
              }
            }
          },
          {
            name: "get_code_context_exa",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" }
              }
            }
          }
        ]
      };
    }

    async callTool(input: { name: string }): Promise<unknown> {
      assert.equal(input.name, "get_code_context_exa");
      return {
        structuredContent: {
          items: [
            {
              title: "Tool Registry",
              url: "https://example.com/tool-registry",
              snippet: "registry.register(tool)",
              content: "full content"
            }
          ]
        }
      };
    }

    async close(): Promise<void> {}
  }

  const service = new ExaSearchService(() => config, {
    loadSdk: async () => ({
      Client: FakeClient,
      StreamableHTTPClientTransport: class {}
    })
  });

  const result = await service.searchCode("tool registry");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.title, "Tool Registry");
  assert.equal(result.items[0]?.url, "https://example.com/tool-registry");
  assert.equal(result.items[0]?.snippet, "registry.register(tool)");
  assert.equal(result.items[0]?.content, "full content");
  await service.dispose();
});

test("ExaSearchService: translates free-tier rate limit errors", async () => {
  const config = cloneConfig();

  class FakeClient {
    async connect(): Promise<void> {}

    async listTools(): Promise<unknown> {
      return {
        tools: [
          {
            name: "web_search_exa",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" }
              }
            }
          },
          {
            name: "get_code_context_exa",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" }
              }
            }
          }
        ]
      };
    }

    async callTool(): Promise<unknown> {
      throw new Error("You've hit Exa's free MCP rate limit (429)");
    }

    async close(): Promise<void> {}
  }

  const service = new ExaSearchService(() => config, {
    loadSdk: async () => ({
      Client: FakeClient,
      StreamableHTTPClientTransport: class {}
    })
  });

  await assert.rejects(() => service.searchWeb("yobi"), /Exa 免费额度限流，请稍后再试/);
  await service.dispose();
});
