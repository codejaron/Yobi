import type { AppConfig } from "@shared/types";

export interface OpenClawResult {
  ok: boolean;
  text: string;
  raw?: unknown;
}

export class OpenClawClient {
  constructor(private readonly getConfig: () => AppConfig) {}

  async send(instruction: string, sessionKey?: string): Promise<OpenClawResult> {
    const url = new URL("/hooks/agent", this.getConfig().openclaw.gatewayUrl).toString();

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        instruction,
        sessionKey
      })
    });

    const bodyText = await response.text();
    let raw: unknown = bodyText;
    try {
      raw = JSON.parse(bodyText);
    } catch {
      raw = bodyText;
    }

    if (!response.ok) {
      return {
        ok: false,
        text: typeof raw === "string" ? raw : JSON.stringify(raw),
        raw
      };
    }

    if (raw && typeof raw === "object") {
      const payload = raw as Record<string, unknown>;
      const output =
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
