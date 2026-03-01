export function makeClientId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

export function summarizeUnknown(value: unknown, maxLength = 240): string {
  let text = "";
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }

  const normalized = text.trim();
  if (!normalized) {
    return "(空)";
  }

  if (maxLength <= 0 || normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}...`;
}

export function singleLine(value: string, maxLength?: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "(空)";
  }

  if (typeof maxLength !== "number" || !Number.isFinite(maxLength) || maxLength <= 0) {
    return compact;
  }

  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}
