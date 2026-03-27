export const CONSOLE_CHAT_AUTO_FOLLOW_THRESHOLD_PX = 80;
export const CONSOLE_CHAT_LOAD_OLDER_THRESHOLD_PX = 120;

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

export function isConsoleChatNearTop(
  metrics: ConsoleChatScrollMetrics,
  thresholdPx = CONSOLE_CHAT_LOAD_OLDER_THRESHOLD_PX
): boolean {
  return metrics.scrollTop <= thresholdPx;
}

export function shouldLoadOlderConsoleChatHistory(input: {
  historyLoaded: boolean;
  hasMore: boolean;
  loadingOlder: boolean;
  metrics: ConsoleChatScrollMetrics;
  thresholdPx?: number;
}): boolean {
  return (
    input.historyLoaded &&
    input.hasMore &&
    !input.loadingOlder &&
    isConsoleChatNearTop(input.metrics, input.thresholdPx)
  );
}

export function shouldAutoLoadOlderConsoleChatHistory(input: {
  historyLoaded: boolean;
  hasMore: boolean;
  loadingOlder: boolean;
  metrics: ConsoleChatScrollMetrics;
}): boolean {
  return (
    input.historyLoaded &&
    input.hasMore &&
    !input.loadingOlder &&
    input.metrics.scrollHeight <= input.metrics.clientHeight
  );
}

export function getPrependedConsoleChatScrollTop(input: {
  previousScrollTop: number;
  previousScrollHeight: number;
  nextScrollHeight: number;
}): number {
  return Math.max(0, input.previousScrollTop + (input.nextScrollHeight - input.previousScrollHeight));
}

export function getNextConsoleChatAutoFollowState(
  action: ConsoleChatAutoFollowAction
): boolean {
  if (action.type === "user-scroll") {
    return isConsoleChatNearBottom(action.metrics);
  }

  return true;
}
