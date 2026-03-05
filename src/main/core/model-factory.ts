import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { AppConfig, ProviderConfig } from "@shared/types";

type JsonRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function downgradeDeveloperRoleEntries(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  let changed = false;
  const mapped = value.map((item) => {
    if (!isPlainRecord(item) || item.role !== "developer") {
      return item;
    }

    changed = true;
    return {
      ...item,
      role: "system"
    };
  });

  return changed ? mapped : value;
}

function rewriteCustomOpenAIRequestBody(body: RequestInit["body"]): RequestInit["body"] {
  if (typeof body !== "string") {
    return body;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }

  if (!isPlainRecord(parsed)) {
    return body;
  }

  const nextMessages = downgradeDeveloperRoleEntries(parsed.messages);
  const nextInput = downgradeDeveloperRoleEntries(parsed.input);
  if (nextMessages === parsed.messages && nextInput === parsed.input) {
    return body;
  }

  return JSON.stringify({
    ...parsed,
    messages: nextMessages,
    input: nextInput
  });
}

function createCustomOpenAICompatFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    if (!init) {
      return baseFetch(input);
    }

    const rewrittenBody = rewriteCustomOpenAIRequestBody(init.body);
    if (rewrittenBody === init.body) {
      return baseFetch(input, init);
    }

    return baseFetch(input, {
      ...init,
      body: rewrittenBody
    });
  };
}

function normalizeCustomOpenAIBaseUrl(raw: string): string {
  const input = raw.trim();
  if (!input) {
    return input;
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return input;
  }

  const pathname = parsed.pathname.trim();
  if (pathname === "" || pathname === "/") {
    parsed.pathname = "/v1";
    return parsed.toString().replace(/\/$/, "");
  }

  return input.replace(/\/$/, "");
}

export function createModelForProvider(provider: ProviderConfig, model: string): any {
  if (!provider.enabled) {
    throw new Error(`Provider ${provider.id} is disabled`);
  }

  if (provider.kind === "anthropic") {
    return createAnthropic({
      apiKey: provider.apiKey
    })(model);
  }

  if (provider.kind === "openrouter") {
    return createOpenRouter({
      apiKey: provider.apiKey
    }).chat(model);
  }

  if (provider.kind === "custom-openai") {
    if (!provider.baseUrl) {
      throw new Error(`Provider ${provider.id} missing baseUrl`);
    }

    const normalizedBaseUrl = normalizeCustomOpenAIBaseUrl(provider.baseUrl);
    const client = createOpenAI({
      apiKey: provider.apiKey,
      baseURL: normalizedBaseUrl,
      fetch: createCustomOpenAICompatFetch()
    });
    return provider.apiMode === "responses" ? client.responses(model as any) : client.chat(model as any);
  }

  const client = createOpenAI({
    apiKey: provider.apiKey
  });

  return provider.apiMode === "responses" ? client.responses(model as any) : client.chat(model as any);
}

export class ModelFactory {
  constructor(private readonly getConfig: () => AppConfig) {}

  private getModelByRoute(routeKey: "chat" | "factExtraction" | "reflection"): any {
    const routes = this.getConfig().modelRouting;
    const route = routes[routeKey];
    if (!route) {
      throw new Error(`Missing model route: ${routeKey}`);
    }

    const provider = this.getConfig().providers.find((candidate) => candidate.id === route.providerId);
    if (!provider) {
      throw new Error(`Missing provider for ${routeKey} route: ${route.providerId}`);
    }
    return createModelForProvider(provider, route.model);
  }

  getChatModel(): any {
    return this.getModelByRoute("chat");
  }

  getFactExtractionModel(): any {
    return this.getModelByRoute("factExtraction");
  }

  getReflectionModel(): any {
    return this.getModelByRoute("reflection");
  }
}
