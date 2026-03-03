import type { TokenUsageSource } from "@shared/types";

export interface TokenUsageReportEvent {
  source: TokenUsageSource;
  usage?: unknown;
  inputText?: string;
  outputText?: string;
  systemText?: string;
  timestamp?: string | number | Date | null;
}

export type TokenUsageRecorder = (
  event: TokenUsageReportEvent
) => Promise<void> | void;

let recorder: TokenUsageRecorder | null = null;
let hasWarnedNoRecorder = false;

export function setTokenRecorder(next: TokenUsageRecorder | null): void {
  recorder = next;
  hasWarnedNoRecorder = false;
}

export function reportTokenUsage(event: TokenUsageReportEvent): void {
  if (!recorder) {
    if (!hasWarnedNoRecorder) {
      hasWarnedNoRecorder = true;
      console.debug("[token] recorder not configured; usage event skipped");
    }
    return;
  }

  const payload: TokenUsageReportEvent = {
    ...event
  };

  void Promise.resolve()
    .then(() => recorder?.(payload))
    .catch((error) => {
      console.warn("[token] failed to record usage:", error);
    });
}
