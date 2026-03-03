export interface ParsedTokenUsage {
  tokens: number;
  mode: "provider" | "estimated" | "missing";
  estimated: boolean;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function resolveUsageRecord(raw: unknown): Record<string, unknown> | null {
  const direct = asRecord(raw);
  if (!direct) {
    return null;
  }

  const nested = asRecord(direct.usage);
  if (nested) {
    return nested;
  }

  return direct;
}

export function parseUsageTokens(raw: unknown): ParsedTokenUsage {
  const usage = resolveUsageRecord(raw);
  if (!usage) {
    return {
      tokens: 0,
      mode: "missing",
      estimated: false
    };
  }

  const totalCandidates = [usage.totalTokens, usage.total_tokens, usage.total];
  for (const candidate of totalCandidates) {
    const total = toFiniteNumber(candidate);
    if (total !== null) {
      return {
        tokens: Math.max(0, Math.floor(total)),
        mode: "provider",
        estimated: false
      };
    }
  }

  const inputCandidates = [usage.inputTokens, usage.promptTokens, usage.prompt_tokens, usage.input_tokens];
  const outputCandidates = [
    usage.outputTokens,
    usage.completionTokens,
    usage.completion_tokens,
    usage.output_tokens
  ];

  let hasProviderFields = false;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const candidate of inputCandidates) {
    const value = toFiniteNumber(candidate);
    if (value !== null) {
      hasProviderFields = true;
      inputTokens = Math.max(inputTokens, value);
    }
  }

  for (const candidate of outputCandidates) {
    const value = toFiniteNumber(candidate);
    if (value !== null) {
      hasProviderFields = true;
      outputTokens = Math.max(outputTokens, value);
    }
  }

  if (!hasProviderFields) {
    return {
      tokens: 0,
      mode: "missing",
      estimated: false
    };
  }

  return {
    tokens: Math.max(0, Math.floor(inputTokens + outputTokens)),
    mode: "provider",
    estimated: false
  };
}

export function estimateTokensFromText(...texts: Array<string | undefined>): number {
  let length = 0;
  for (const text of texts) {
    if (typeof text !== "string") {
      continue;
    }

    const normalized = text.trim();
    if (!normalized) {
      continue;
    }

    length += normalized.length;
  }

  if (length <= 0) {
    return 0;
  }

  return Math.max(1, Math.ceil(length / 4));
}
