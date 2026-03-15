import type { AppConfig } from "@shared/types";
import type { streamText } from "ai";
import { providerUsesResponsesApi } from "./model-factory";

type StreamProviderOptions = NonNullable<Parameters<typeof streamText>[0]["providerOptions"]>;

export function resolveOpenAIStoreOption(config: AppConfig): StreamProviderOptions | undefined {
  const route = config.modelRouting.chat;
  const provider = config.providers.find((candidate) => candidate.id === route.providerId);
  if (!provider) {
    return undefined;
  }

  if (!providerUsesResponsesApi(provider)) {
    return undefined;
  }

  return {
    openai: {
      store: false
    }
  } as StreamProviderOptions;
}
