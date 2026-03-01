import type { AppConfig } from "@shared/types";
import type { streamText } from "ai";

type StreamProviderOptions = NonNullable<Parameters<typeof streamText>[0]["providerOptions"]>;

export function resolveOpenAIStoreOption(config: AppConfig): StreamProviderOptions | undefined {
  const route = config.modelRouting.chat;
  const provider = config.providers.find((candidate) => candidate.id === route.providerId);
  if (!provider) {
    return undefined;
  }

  const usesResponsesApi =
    (provider.kind === "openai" || provider.kind === "custom-openai") &&
    provider.apiMode === "responses";

  if (!usesResponsesApi) {
    return undefined;
  }

  return {
    openai: {
      store: false
    }
  } as StreamProviderOptions;
}
