import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { AppConfig, ProviderConfig } from "@shared/types";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function resolveRequestUrl(input: FetchInput): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }

  return String(input);
}

function resolveRequestMethod(input: FetchInput, init?: FetchInit): string {
  if (init?.method) {
    return init.method.toUpperCase();
  }

  if (typeof Request !== "undefined" && input instanceof Request && input.method) {
    return input.method.toUpperCase();
  }

  return "GET";
}

function createProviderLoggingFetch(provider: ProviderConfig, model: string): typeof fetch {
  return async (input, init) => {
    const url = resolveRequestUrl(input);
    const method = resolveRequestMethod(input, init);
    const startedAt = Date.now();
    console.info(
      `[provider] request provider=${provider.id} kind=${provider.kind} apiMode=${provider.apiMode} model=${model} method=${method} url=${url}`
    );

    try {
      const response = await fetch(input, init);
      console.info(
        `[provider] response provider=${provider.id} kind=${provider.kind} apiMode=${provider.apiMode} model=${model} method=${method} status=${response.status} url=${url} durationMs=${Date.now() - startedAt}`
      );
      return response;
    } catch (error) {
      console.warn(
        `[provider] failed provider=${provider.id} kind=${provider.kind} apiMode=${provider.apiMode} model=${model} method=${method} url=${url}`,
        error
      );
      throw error;
    }
  };
}

export function normalizeCustomOpenAIBaseUrl(raw: string): string {
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
      fetch: createProviderLoggingFetch(provider, model)
    });
    return provider.apiMode === "responses" ? client.responses(model as any) : client.chat(model as any);
  }

  const client = createOpenAI({
    apiKey: provider.apiKey,
    fetch: createProviderLoggingFetch(provider, model)
  });

  return provider.apiMode === "responses" ? client.responses(model as any) : client.chat(model as any);
}

export class ModelFactory {
  constructor(private readonly getConfig: () => AppConfig) {}

  getChatModel(): any {
    const route = this.getConfig().modelRouting.chat;
    const provider = this.getConfig().providers.find((candidate) => candidate.id === route.providerId);
    if (!provider) {
      throw new Error(`Missing provider for chat route: ${route.providerId}`);
    }

    return createModelForProvider(provider, route.model);
  }
}
