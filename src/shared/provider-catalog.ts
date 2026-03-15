export const PROVIDER_KINDS = [
  "openai",
  "anthropic",
  "custom-openai",
  "openrouter",
  "deepseek",
  "qwen",
  "moonshot",
  "zhipu",
  "minimax"
] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const PROVIDER_API_MODES = ["chat", "responses"] as const;
export type ProviderApiMode = (typeof PROVIDER_API_MODES)[number];

export const QWEN_REGIONS = ["cn", "intl"] as const;
export type QwenRegion = (typeof QWEN_REGIONS)[number];

export interface ProviderDraftLike {
  id: string;
  label: string;
  kind: ProviderKind;
  apiMode: ProviderApiMode;
  apiKey: string;
  enabled: boolean;
  baseUrl?: string | undefined;
  qwenRegion?: QwenRegion | undefined;
}

export interface ProviderKindMetadata {
  label: string;
  supportsResponsesApi: boolean;
  allowsBaseUrlEdit: boolean;
  supportsModelDiscovery: boolean;
}

export interface ProviderModelOption {
  value: string;
  label: string;
  capabilities: string[];
  taskTypes: string[];
}

export const PROVIDER_MODEL_DISCOVERY_ERROR_CODES = [
  "missing_key",
  "auth_failed",
  "forbidden",
  "rate_limited",
  "network_error",
  "provider_error",
  "empty_result"
] as const;

export type ProviderModelDiscoveryErrorCode = (typeof PROVIDER_MODEL_DISCOVERY_ERROR_CODES)[number];

export interface ProviderModelDiscoveryError {
  code: ProviderModelDiscoveryErrorCode;
  message: string;
  details: string | null;
  status: number | null;
}

export interface ProviderModelListResult {
  items: ProviderModelOption[];
  allItems: ProviderModelOption[];
  source: "remote";
  fetchedAt: string;
  error: ProviderModelDiscoveryError | null;
}

export const PROVIDER_KIND_METADATA: Record<ProviderKind, ProviderKindMetadata> = {
  openai: {
    label: "OpenAI",
    supportsResponsesApi: true,
    allowsBaseUrlEdit: false,
    supportsModelDiscovery: true
  },
  anthropic: {
    label: "Anthropic",
    supportsResponsesApi: false,
    allowsBaseUrlEdit: false,
    supportsModelDiscovery: false
  },
  "custom-openai": {
    label: "Custom Provider",
    supportsResponsesApi: true,
    allowsBaseUrlEdit: true,
    supportsModelDiscovery: true
  },
  openrouter: {
    label: "OpenRouter",
    supportsResponsesApi: false,
    allowsBaseUrlEdit: false,
    supportsModelDiscovery: false
  },
  deepseek: {
    label: "DeepSeek",
    supportsResponsesApi: false,
    allowsBaseUrlEdit: false,
    supportsModelDiscovery: true
  },
  qwen: {
    label: "Qwen",
    supportsResponsesApi: false,
    allowsBaseUrlEdit: false,
    supportsModelDiscovery: true
  },
  moonshot: {
    label: "Moonshot",
    supportsResponsesApi: false,
    allowsBaseUrlEdit: false,
    supportsModelDiscovery: true
  },
  zhipu: {
    label: "Zhipu",
    supportsResponsesApi: false,
    allowsBaseUrlEdit: false,
    supportsModelDiscovery: true
  },
  minimax: {
    label: "MiniMax",
    supportsResponsesApi: false,
    allowsBaseUrlEdit: false,
    supportsModelDiscovery: true
  }
};

export function supportsResponsesApi(kind: ProviderKind): boolean {
  return PROVIDER_KIND_METADATA[kind].supportsResponsesApi;
}

export function supportsModelDiscovery(kind: ProviderKind): boolean {
  return PROVIDER_KIND_METADATA[kind].supportsModelDiscovery;
}

export function resolveProviderBaseUrl(provider: Pick<ProviderDraftLike, "kind" | "baseUrl" | "qwenRegion">): string | undefined {
  if (provider.kind === "custom-openai") {
    return provider.baseUrl?.trim() || "https://api.openai.com/v1";
  }

  if (provider.kind === "openai") {
    return "https://api.openai.com/v1";
  }

  if (provider.kind === "deepseek") {
    return "https://api.deepseek.com";
  }

  if (provider.kind === "qwen") {
    if (provider.qwenRegion === "intl") {
      return "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
    }
    return "https://dashscope.aliyuncs.com/compatible-mode/v1";
  }

  if (provider.kind === "moonshot") {
    return "https://api.moonshot.ai/v1";
  }

  if (provider.kind === "zhipu") {
    return "https://open.bigmodel.cn/api/paas/v4";
  }

  if (provider.kind === "minimax") {
    return "https://api.minimax.io/v1";
  }

  return undefined;
}

export function applyProviderKindDefaults(provider: ProviderDraftLike): ProviderDraftLike {
  const metadata = PROVIDER_KIND_METADATA[provider.kind];
  const nextApiMode = metadata.supportsResponsesApi ? provider.apiMode : "chat";

  const nextProvider: ProviderDraftLike = {
    ...provider,
    label: provider.label.trim() || metadata.label,
    apiMode: nextApiMode
  };

  if (provider.kind === "custom-openai") {
    nextProvider.baseUrl = resolveProviderBaseUrl(provider);
  } else {
    nextProvider.baseUrl = undefined;
  }

  if (provider.kind === "qwen") {
    nextProvider.qwenRegion = provider.qwenRegion ?? "cn";
  } else {
    nextProvider.qwenRegion = undefined;
  }

  return nextProvider;
}

export function getProviderKindLabel(kind: ProviderKind): string {
  return PROVIDER_KIND_METADATA[kind].label;
}
