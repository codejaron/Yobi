import type { BufferMessage } from "@shared/types";

export function normalizeBufferRow(raw: unknown): BufferMessage | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : "";
  const ts = typeof row.ts === "string" ? row.ts : "";
  const role =
    row.role === "system" || row.role === "assistant" || row.role === "user" ? row.role : null;
  const channel = row.channel === "telegram" || row.channel === "qq" ? row.channel : "console";
  const text = typeof row.text === "string" ? row.text.trim() : "";
  if (!id || !ts || !role || !text) {
    return null;
  }
  return {
    id,
    ts,
    role,
    channel,
    text,
    meta: row.meta && typeof row.meta === "object" ? (row.meta as Record<string, unknown>) : undefined,
    extracted: Boolean(row.extracted)
  };
}
