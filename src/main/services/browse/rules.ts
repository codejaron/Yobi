export interface EventShareCheckInput {
  todayEventShares: number;
  eventDailyCap: number;
  elapsedSinceInteractionMs: number;
  eventMinGapMs: number;
}

export function isInterestColdStart(includeInterestTermCount: number): boolean {
  return includeInterestTermCount < 3;
}

export function canEventShare(input: EventShareCheckInput): boolean {
  if (input.todayEventShares >= input.eventDailyCap) {
    return false;
  }

  if (input.elapsedSinceInteractionMs < input.eventMinGapMs) {
    return false;
  }

  return true;
}

export function nextAuthStateFromNav(isLogin: boolean): {
  authState: "active" | "expired";
  pausedReason: string | null;
} {
  if (isLogin) {
    return {
      authState: "active",
      pausedReason: null
    };
  }

  return {
    authState: "expired",
    pausedReason: "Cookie 已失效，请重新扫码"
  };
}
