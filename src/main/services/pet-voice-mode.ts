import type { AppConfig } from "@shared/types";

export function shouldUseUnifiedRealtimeVoice(config: Pick<AppConfig, "realtimeVoice">): boolean {
  return config.realtimeVoice.enabled && config.realtimeVoice.mode === "free";
}

export function shouldUseLegacySerialPtt(config: Pick<AppConfig, "realtimeVoice">): boolean {
  return !shouldUseUnifiedRealtimeVoice(config);
}
