import type { AppConfig } from "@shared/types";
import { OPENCLAW_HOOK_PATH, OPENCLAW_HOOK_TOKEN } from "./constants";

export interface OpenClawResult {
  ok: boolean;
  text: string;
  raw?: unknown;
}

function summarizeBody(raw: unknown): string {
  if (typeof raw === "string") {
    return raw.trim();
  }

  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

export class OpenClawClient {
  constructor(private readonly getConfig: () => AppConfig) {}

  async send(instruction: string): Promise<OpenClawResult> {
    const url = new URL(`${OPENCLAW_HOOK_PATH}/agent`, this.getConfig().openclaw.gatewayUrl).toString();
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openclaw-token": OPENCLAW_HOOK_TOKEN
        },
        body: JSON.stringify({
          message: instruction,
          name: "Yobi",
          deliver: false
        })
      });
    } catch (error) {
      const reason =
        error instanceof Error ? `${error.name}: ${error.message}` : "未知网络错误";
      return {
        ok: false,
        text: [`Network Error`, `POST ${url}`, `Reason: ${reason}`].join("\n"),
        raw: {
          url,
          error: reason
        }
      };
    }

    const bodyText = await response.text();
    let raw: unknown = bodyText;
    try {
      raw = JSON.parse(bodyText);
    } catch {
      raw = bodyText;
    }

    if (!response.ok) {
      const allow = response.headers.get("allow");
      const bodySummary = summarizeBody(raw);
      const lines = [
        `HTTP ${response.status} ${response.statusText || "Error"}`,
        allow ? `Allow: ${allow}` : "",
        `POST ${url}`,
        bodySummary ? `Body: ${bodySummary}` : ""
      ].filter(Boolean);

      return {
        ok: false,
        text: lines.join("\n"),
        raw: {
          status: response.status,
          statusText: response.statusText,
          allow,
          url,
          body: raw
        }
      };
    }

    if (raw && typeof raw === "object") {
      const payload = raw as Record<string, unknown>;
      const output =
        (typeof payload.runId === "string" && payload.runId && `OpenClaw 任务已提交（runId: ${payload.runId}）`) ||
        (typeof payload.output === "string" && payload.output) ||
        (typeof payload.message === "string" && payload.message) ||
        (typeof payload.text === "string" && payload.text) ||
        JSON.stringify(payload);

      return {
        ok: true,
        text: output,
        raw
      };
    }

    return {
      ok: true,
      text: typeof raw === "string" ? raw : JSON.stringify(raw),
      raw
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const url = new URL("/health", this.getConfig().openclaw.gatewayUrl).toString();
      const response = await fetch(url, {
        method: "GET"
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
