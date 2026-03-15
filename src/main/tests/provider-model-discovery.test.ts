import test from "node:test";
import assert from "node:assert/strict";
import { ProviderModelDiscoveryService } from "../services/provider-model-discovery.js";
import type { ProviderConfig } from "@shared/types";

function createProvider(
  patch: Partial<ProviderConfig> & Pick<ProviderConfig, "kind">
): ProviderConfig {
  return {
    id: "provider-1",
    label: "Provider",
    apiMode: "chat",
    apiKey: "demo-key",
    enabled: true,
    qwenRegion: "cn",
    ...patch
  };
}

test("ProviderModelDiscoveryService: keeps chat-capable models and preserves provider order", async () => {
  const service = new ProviderModelDiscoveryService({
    fetch: async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "chat-alpha",
              capabilities: ["chat"]
            },
            {
              id: "embed-alpha",
              capabilities: ["embedding"]
            },
            {
              id: "multi-beta",
              task_types: ["multimodal-chat"]
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      )
  });

  const result = await service.listModels({
    provider: createProvider({
      kind: "deepseek"
    })
  });

  assert.equal(result.error, null);
  assert.deepEqual(
    result.items.map((item) => item.value),
    ["chat-alpha", "multi-beta"]
  );
  assert.deepEqual(
    result.allItems.map((item) => item.value),
    ["chat-alpha", "embed-alpha", "multi-beta"]
  );
});

test("ProviderModelDiscoveryService: filters obvious non-chat ids when only raw model ids are returned", async () => {
  const service = new ProviderModelDiscoveryService({
    fetch: async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "moonshot-v1-8k" },
            { id: "text-embedding-v3" },
            { id: "kimi-latest" },
            { id: "tts-1" }
          ]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      )
  });

  const result = await service.listModels({
    provider: createProvider({
      kind: "moonshot"
    })
  });

  assert.equal(result.error, null);
  assert.deepEqual(
    result.items.map((item) => item.value),
    ["moonshot-v1-8k", "kimi-latest"]
  );
});

test("ProviderModelDiscoveryService: normalizes auth and empty-result failures", async () => {
  const invalidKeyService = new ProviderModelDiscoveryService({
    fetch: async () =>
      new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
        status: 401,
        headers: {
          "content-type": "application/json"
        }
      })
  });

  const invalidKeyResult = await invalidKeyService.listModels({
    provider: createProvider({
      kind: "zhipu"
    })
  });

  assert.equal(invalidKeyResult.items.length, 0);
  assert.equal(invalidKeyResult.error?.code, "auth_failed");

  const emptyService = new ProviderModelDiscoveryService({
    fetch: async () =>
      new Response(JSON.stringify({ data: [{ id: "embedding-large" }] }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      })
  });

  const emptyResult = await emptyService.listModels({
    provider: createProvider({
      kind: "minimax"
    })
  });

  assert.equal(emptyResult.items.length, 0);
  assert.equal(emptyResult.error?.code, "empty_result");
});
