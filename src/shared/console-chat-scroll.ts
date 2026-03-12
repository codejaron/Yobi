export const CONSOLE_CHAT_AUTO_FOLLOW_THRESHOLD_PX = 80;

export interface ConsoleChatScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export type ConsoleChatAutoFollowAction =
  | {
      type: "history-loaded" | "submit-message";
    }
  | {
      type: "user-scroll";
      metrics: ConsoleChatScrollMetrics;
    };

export function isConsoleChatNearBottom(
  metrics: ConsoleChatScrollMetrics,
  thresholdPx = CONSOLE_CHAT_AUTO_FOLLOW_THRESHOLD_PX
): boolean {
  const distanceFromBottom = metrics.scrollHeight - (metrics.scrollTop + metrics.clientHeight);
  return distanceFromBottom <= thresholdPx;
}

export function getNextConsoleChatAutoFollowState(
  action: ConsoleChatAutoFollowAction
): boolean {
  if (action.type === "user-scroll") {
    return isConsoleChatNearBottom(action.metrics);
  }

  return true;
}
