import test from "node:test";
import assert from "node:assert/strict";
import { generateText } from "ai";
import { createAlibaba } from "@ai-sdk/alibaba";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
import { createModelForProvider, providerUsesResponsesApi } from "../core/model-factory.js";
import type { ProviderConfig } from "@shared/types";

function createProvider(patch: Partial<ProviderConfig> & Pick<ProviderConfig, "kind">): ProviderConfig {
  return {
    id: `provider-${patch.kind}`,
    label: patch.kind,
    apiMode: "chat",
    apiKey: "demo-key",
    enabled: true,
    ...patch
  };
}

test("createModelForProvider: instantiates new provider kinds without network calls", () => {
  const providers: ProviderConfig[] = [
    createProvider({ kind: "deepseek" }),
    createProvider({ kind: "qwen", qwenRegion: "cn" }),
    createProvider({ kind: "moonshot" }),
    createProvider({ kind: "zhipu" }),
    createProvider({ kind: "minimax" })
  ];

  for (const provider of providers) {
    const model = createModelForProvider(provider, "demo-model");
    assert.equal(typeof model, "object");
    assert.ok(model);
  }
});

test("AI SDK accepts OpenAI-compatible provider models used by Yobi", async () => {
  const createSuccessResponse = (model: string) =>
    new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "ok"
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2
        }
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );

  const calls: Array<{ provider: string; url: string }> = [];
  const fetchStub: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const provider = url.includes("dashscope")
      ? "qwen"
      : url.includes("deepseek")
        ? "deepseek"
        : "moonshot";
    calls.push({ provider, url });
    return createSuccessResponse(provider);
  };

  const cases = [
    {
      name: "qwen",
      model: createAlibaba({
        apiKey: "demo-key",
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        fetch: fetchStub
      }).chatModel("qwen3.5-flash-2026-02-23")
    },
    {
      name: "deepseek",
      model: createDeepSeek({
        apiKey: "demo-key",
        baseURL: "https://api.deepseek.com",
        fetch: fetchStub
      }).chat("deepseek-chat")
    },
    {
      name: "moonshot",
      model: createMoonshotAI({
        apiKey: "demo-key",
        baseURL: "https://api.moonshot.ai/v1",
        fetch: fetchStub
      }).chatModel("kimi-k2")
    }
  ] as const;

  for (const testCase of cases) {
    const result = await generateText({
      model: testCase.model,
      prompt: "hello"
    });

    assert.equal(result.text, "ok");
  }

  assert.deepEqual(
    calls.map((call) => call.provider),
    ["qwen", "deepseek", "moonshot"]
  );
});

test("providerUsesResponsesApi: only OpenAI flavors opt into responses", () => {
  assert.equal(
    providerUsesResponsesApi(
      createProvider({
        kind: "openai",
        apiMode: "responses"
      })
    ),
    true
  );
  assert.equal(
    providerUsesResponsesApi(
      createProvider({
        kind: "custom-openai",
        apiMode: "responses",
        baseUrl: "https://example.com/v1"
      })
    ),
    true
  );
  assert.equal(
    providerUsesResponsesApi(
      createProvider({
        kind: "qwen",
        apiMode: "responses",
        qwenRegion: "cn"
      })
    ),
    false
  );
});
