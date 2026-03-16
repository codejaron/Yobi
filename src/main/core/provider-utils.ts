import type { AppConfig, ChatAttachment, ProviderConfig } from "@shared/types";
import type { streamText } from "ai";
import { providerUsesResponsesApi } from "./model-factory";

type StreamProviderOptions = NonNullable<Parameters<typeof streamText>[0]["providerOptions"]>;

export function resolveOpenAIStoreOption(config: AppConfig): StreamProviderOptions | undefined {
  const provider = resolveChatProvider(config);
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

export function resolveChatProvider(config: AppConfig): ProviderConfig | undefined {
  const route = config.modelRouting.chat;
  return config.providers.find((candidate) => candidate.id === route.providerId);
}

export function supportsChatToolResultMedia(config: AppConfig): boolean {
  const provider = resolveChatProvider(config);
  if (!provider) {
    return false;
  }

  if (provider.kind === "anthropic") {
    return provider.apiMode === "chat";
  }

  if (provider.kind === "openai" || provider.kind === "custom-openai") {
    return providerUsesResponsesApi(provider);
  }

  return false;
}

export function supportsChatAttachment(config: AppConfig, attachment: Pick<ChatAttachment, "kind" | "mimeType">): boolean {
  const provider = resolveChatProvider(config);
  if (!provider) {
    return false;
  }

  const mimeType = attachment.mimeType.toLowerCase();
  const isImage = attachment.kind === "image" || mimeType.startsWith("image/");
  const isPdf = mimeType === "application/pdf";
  const isText = mimeType === "text/plain";

  if (provider.kind === "anthropic") {
    return isImage || isPdf || isText;
  }

  if (provider.kind === "openai" || provider.kind === "custom-openai" || provider.kind === "openrouter") {
    return isImage || isPdf || isText;
  }

  if (provider.kind === "qwen") {
    return isImage;
  }

  return false;
}
