import test from "node:test";
import assert from "node:assert/strict";
import { providerSchema } from "@shared/types";
import {
  applyProviderKindDefaults,
  resolveProviderBaseUrl,
  supportsResponsesApi
} from "@shared/provider-catalog";

test("providerSchema: accepts new provider kinds and limits Qwen region to cn/intl", () => {
  const qwenCn = providerSchema.parse({
    id: "qwen-main",
    label: "Qwen",
    kind: "qwen",
    apiMode: "chat",
    apiKey: "demo",
    qwenRegion: "cn",
    enabled: true
  });

  const qwenIntl = providerSchema.parse({
    id: "qwen-intl",
    label: "Qwen Intl",
    kind: "qwen",
    apiMode: "chat",
    apiKey: "demo",
    qwenRegion: "intl",
    enabled: true
  });

  const deepseek = providerSchema.parse({
    id: "deepseek-main",
    label: "DeepSeek",
    kind: "deepseek",
    apiMode: "chat",
    apiKey: "demo",
    enabled: true
  });

  assert.equal(qwenCn.qwenRegion, "cn");
  assert.equal(qwenIntl.qwenRegion, "intl");
  assert.equal(deepseek.kind, "deepseek");

  assert.throws(() =>
    providerSchema.parse({
      id: "qwen-us",
      label: "Qwen US",
      kind: "qwen",
      apiMode: "chat",
      apiKey: "demo",
      qwenRegion: "us",
      enabled: true
    })
  );
});

test("provider catalog: applies kind defaults and only exposes responses for OpenAI flavors", () => {
  const qwen = applyProviderKindDefaults({
    id: "provider-1",
    label: "",
    kind: "qwen",
    apiMode: "responses",
    apiKey: "",
    enabled: true
  });
  const custom = applyProviderKindDefaults({
    id: "provider-2",
    label: "",
    kind: "custom-openai",
    apiMode: "chat",
    apiKey: "",
    enabled: true
  });

  assert.equal(qwen.label, "Qwen");
  assert.equal(qwen.apiMode, "chat");
  assert.equal(qwen.qwenRegion, "cn");
  assert.equal(resolveProviderBaseUrl(qwen), "https://dashscope.aliyuncs.com/compatible-mode/v1");

  assert.equal(custom.label, "Custom Provider");
  assert.equal(custom.baseUrl, "https://api.openai.com/v1");

  assert.equal(supportsResponsesApi("openai"), true);
  assert.equal(supportsResponsesApi("custom-openai"), true);
  assert.equal(supportsResponsesApi("qwen"), false);
  assert.equal(supportsResponsesApi("moonshot"), false);
});
