import type { TokenUsageSource } from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import { AppLogger } from "@main/services/logger";
const logger = new AppLogger(new CompanionPaths());

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
      logger.info("token", "recorder-missing");
    }
    return;
  }

  const payload: TokenUsageReportEvent = {
    ...event
  };

  void Promise.resolve()
    .then(() => recorder?.(payload))
    .catch((error) => {
      logger.warn("[token] failed to record usage:", error);
    });
}
