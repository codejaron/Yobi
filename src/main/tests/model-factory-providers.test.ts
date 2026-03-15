import test from "node:test";
import assert from "node:assert/strict";
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
