import { isRecord } from "@main/utils/guards";

export interface ClawReqFrame {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
}

export interface ClawErrorFrame {
  code?: string | number;
  message?: string;
  data?: unknown;
}

export interface ClawResFrame {
  type: "res";
  id: string;
  ok?: boolean;
  result?: unknown;
  error?: ClawErrorFrame;
}

export interface ClawEventFrame {
  type: "event";
  event: string;
  payload?: unknown;
}

type ClawFrame = ClawReqFrame | ClawResFrame | ClawEventFrame;

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toBooleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function parseClawFrame(raw: string): ClawFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const type = toStringValue(parsed.type);
  if (type === "req") {
    const id = toStringValue(parsed.id);
    const method = toStringValue(parsed.method);
    if (!id || !method) {
      return null;
    }

    return {
      type,
      id,
      method,
      params: parsed.params
    };
  }

  if (type === "res") {
    const id = toStringValue(parsed.id);
    if (!id) {
      return null;
    }

    const error = isRecord(parsed.error)
      ? {
          code:
            typeof parsed.error.code === "string" || typeof parsed.error.code === "number"
              ? parsed.error.code
              : undefined,
          message: toStringValue(parsed.error.message),
          data: parsed.error.data
        }
      : undefined;

    return {
      type,
      id,
      ok: toBooleanValue(parsed.ok),
      result: parsed.payload ?? parsed.result,
      error
    };
  }

  if (type === "event") {
    const event = toStringValue(parsed.event);
    if (!event) {
      return null;
    }

    return {
      type,
      event,
      payload: parsed.payload
    };
  }

  return null;
}

export function stringifyClawFrame(frame: ClawFrame): string {
  return JSON.stringify(frame);
}

export function isClawResponseOk(frame: ClawResFrame): boolean {
  if (typeof frame.ok === "boolean") {
    return frame.ok;
  }

  return !frame.error;
}

export function summarizeClawError(frame: ClawResFrame): string {
  if (!frame.error) {
    return "请求失败";
  }

  const codePart =
    typeof frame.error.code === "string" || typeof frame.error.code === "number"
      ? `[${String(frame.error.code)}] `
      : "";
  const message = frame.error.message?.trim() || "请求失败";

  return `${codePart}${message}`;
}

export function isConnectChallengeEvent(frame: ClawEventFrame): boolean {
  return frame.event === "connect.challenge";
}
