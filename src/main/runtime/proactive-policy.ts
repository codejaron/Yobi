import type { AppConfig } from "@shared/types";
import { isWithinQuietHours } from "@main/kernel/relationship-utils";

export function shouldDispatchAutomationMessage(input: {
  metadata: {
    proactive?: boolean;
  };
  proactiveConfig: AppConfig["proactive"];
  now?: Date;
}): boolean {
  if (input.metadata.proactive !== true) {
    return true;
  }

  if (!input.proactiveConfig.enabled) {
    return false;
  }

  return !isWithinQuietHours(input.now ?? new Date(), input.proactiveConfig.quietHours);
}
