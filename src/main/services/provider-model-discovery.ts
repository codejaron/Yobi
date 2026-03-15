import {
  type ProviderModelDiscoveryError,
  type ProviderModelListResult,
  type ProviderModelOption,
  resolveProviderBaseUrl
} from "@shared/provider-catalog";
import { providerSchema, type ProviderConfig } from "@shared/types";

const CHAT_CAPABILITIES = new Set(["chat", "text-generation", "multimodal-chat"]);
const NON_CHAT_MODEL_PATTERN = /(embed|embedding|rerank|tts|speech|asr|transcribe|image|video|music|moderation)/i;

type JsonRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }

  return [];
}

function normalizeCapability(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, "-");
}

function extractModelRecords(payload: unknown): JsonRecord[] {
  if (Array.isArray(payload)) {
    return payload.filter(isPlainRecord);
  }

  if (!isPlainRecord(payload)) {
    return [];
  }

  const directCandidates = [payload.data, payload.models, payload.list];
  for (const candidate of directCandidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(isPlainRecord);
    }
  }

  if (isPlainRecord(payload.data)) {
    const nestedCandidates = [payload.data.models, payload.data.list, payload.data.items];
    for (const candidate of nestedCandidates) {
      if (Array.isArray(candidate)) {
        return candidate.filter(isPlainRecord);
      }
    }
  }

  return [];
}

function normalizeModelOption(record: JsonRecord): ProviderModelOption | null {
  const valueCandidates = [record.id, record.model, record.model_id, record.name];
  const value = valueCandidates.find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
  if (typeof value !== "string") {
    return null;
  }

  const capabilities = toStringArray(record.capabilities ?? record.capability).map(normalizeCapability);
  const taskTypes = toStringArray(record.task_types ?? record.taskTypes ?? record.tasks).map(normalizeCapability);

  return {
    value,
    label: typeof record.name === "string" && record.name.trim().length > 0 ? record.name : value,
    capabilities,
    taskTypes
  };
}

function dedupeModelOptions(items: ProviderModelOption[]): ProviderModelOption[] {
  const seen = new Set<string>();
  const deduped: ProviderModelOption[] = [];
  for (const item of items) {
    if (seen.has(item.value)) {
      continue;
    }
    seen.add(item.value);
    deduped.push(item);
  }
  return deduped;
}

function isChatCapableModel(item: ProviderModelOption): boolean {
  const declaredCapabilities = [...item.capabilities, ...item.taskTypes];
  if (declaredCapabilities.length > 0) {
    return declaredCapabilities.some((value) => CHAT_CAPABILITIES.has(normalizeCapability(value)));
  }

  return !NON_CHAT_MODEL_PATTERN.test(item.value) && !NON_CHAT_MODEL_PATTERN.test(item.label);
}

function extractErrorMessage(payload: unknown): string | null {
  if (typeof payload === "string" && payload.trim().length > 0) {
    return payload.trim();
  }

  if (!isPlainRecord(payload)) {
    return null;
  }

  const error = payload.error;
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }

  if (isPlainRecord(error)) {
    const nestedMessage = error.message;
    if (typeof nestedMessage === "string" && nestedMessage.trim().length > 0) {
      return nestedMessage.trim();
    }
  }

  const failedFlag = payload.success === false || payload.ok === false;
  if (failedFlag) {
    const message = payload.message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  }

  return null;
}

function classifyProviderError(input: {
  status: number | null;
  message: string | null;
}): ProviderModelDiscoveryError {
  const message = input.message?.trim() ?? "";
  const normalized = message.toLowerCase();

  if (
    input.status === 401 ||
    /invalid api key|unauthorized|authentication|incorrect api key|api key is invalid/.test(normalized)
  ) {
    return {
      code: "auth_failed",
      message: "API Key 无效、无权限或未开通该服务",
      details: message || null,
      status: input.status
    };
  }

  if (input.status === 403) {
    return {
      code: "forbidden",
      message: "API Key 无效、无权限或未开通该服务",
      details: message || null,
      status: input.status
    };
  }

  if (input.status === 429) {
    return {
      code: "rate_limited",
      message: "请求过于频繁，请稍后重试",
      details: message || null,
      status: input.status
    };
  }

  return {
    code: "provider_error",
    message: "模型列表拉取失败，请稍后重试或手动填写模型名",
    details: message || null,
    status: input.status
  };
}

export function createMissingKeyError(): ProviderModelDiscoveryError {
  return {
    code: "missing_key",
    message: "请先填写 API Key",
    details: null,
    status: null
  };
}

export function createEmptyResultError(): ProviderModelDiscoveryError {
  return {
    code: "empty_result",
    message: "已连接成功，但当前未返回可用聊天模型，请手动填写模型名",
    details: null,
    status: 200
  };
}

export class ProviderModelDiscoveryService {
  constructor(
    private readonly input: {
      fetch?: typeof fetch;
    } = {}
  ) {}

  async listModels(input: { provider: ProviderConfig }): Promise<ProviderModelListResult> {
    const provider = providerSchema.parse(input.provider);
    const fetchedAt = new Date().toISOString();

    if (provider.apiKey.trim().length === 0) {
      return {
        items: [],
        allItems: [],
        source: "remote",
        fetchedAt,
        error: createMissingKeyError()
      };
    }

    const baseUrl = resolveProviderBaseUrl(provider);
    if (!baseUrl) {
      return {
        items: [],
        allItems: [],
        source: "remote",
        fetchedAt,
        error: {
          code: "provider_error",
          message: "当前 Provider 暂不支持拉取模型列表",
          details: null,
          status: null
        }
      };
    }

    const fetchImpl = this.input.fetch ?? fetch;
    let response: Response;

    try {
      response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/models`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${provider.apiKey.trim()}`,
          Accept: "application/json"
        }
      });
    } catch (error) {
      return {
        items: [],
        allItems: [],
        source: "remote",
        fetchedAt,
        error: {
          code: "network_error",
          message: "网络异常，暂时无法拉取模型列表",
          details: error instanceof Error ? error.message : String(error),
          status: null
        }
      };
    }

    let payload: unknown = null;
    let textBody = "";
    try {
      textBody = await response.text();
      payload = textBody.length > 0 ? JSON.parse(textBody) : null;
    } catch {
      payload = textBody || null;
    }

    const payloadErrorMessage = extractErrorMessage(payload);
    if (!response.ok || payloadErrorMessage) {
      return {
        items: [],
        allItems: [],
        source: "remote",
        fetchedAt,
        error: classifyProviderError({
          status: response.status,
          message: payloadErrorMessage ?? (textBody || response.statusText)
        })
      };
    }

    const allItems = dedupeModelOptions(
      extractModelRecords(payload)
        .map((record) => normalizeModelOption(record))
        .filter((item): item is ProviderModelOption => item !== null)
    );
    const items = allItems.filter(isChatCapableModel);

    if (items.length === 0) {
      return {
        items: [],
        allItems,
        source: "remote",
        fetchedAt,
        error: createEmptyResultError()
      };
    }

    return {
      items,
      allItems,
      source: "remote",
      fetchedAt,
      error: null
    };
  }
}
