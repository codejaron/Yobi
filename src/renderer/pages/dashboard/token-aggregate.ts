import {
  DEFAULT_TOKEN_STATS_STATUS,
  TOKEN_USAGE_SOURCES,
  type TokenSourceCounters,
  type TokenStatsStatus,
  type TokenUsageSource
} from "@shared/types";

export type TokenPeriod = "today" | "7d" | "30d";

export interface TokenBreakdownItem {
  label: string;
  tokens: number;
  estimatedTokens: number;
}

export interface TokenTrendBar {
  dayKey: string;
  totalTokens: number;
  estimatedTokens: number;
  heightPercent: number;
}

export interface TokenAggregateResult {
  period: TokenPeriod;
  totalTokens: number;
  estimatedTokens: number;
  hasEstimated: boolean;
  lastUpdatedAt: string | null;
  sourceTotals: {
    chat: TokenBreakdownItem;
    background: TokenBreakdownItem;
    claw: {
      status: "pending" | "ready";
      label: string;
    };
  };
  backgroundDetails: TokenBreakdownItem[];
  trendBars: TokenTrendBar[];
  trendWindowDays: number;
  trendDowngradedOnMobile: boolean;
}

const CHAT_SOURCES: TokenUsageSource[] = ["chat:console", "chat:telegram", "chat:qq", "chat:feishu"];
const BROWSE_INTEREST_SOURCE: TokenUsageSource = "browse:bilibili-interest";
const BACKGROUND_FACT_EXTRACTION_SOURCE: TokenUsageSource = "background:fact-extraction";
const BACKGROUND_REFLECTION_SOURCE: TokenUsageSource = "background:reflection";
const BACKGROUND_SOURCES: TokenUsageSource[] = [
  BROWSE_INTEREST_SOURCE,
  BACKGROUND_FACT_EXTRACTION_SOURCE,
  BACKGROUND_REFLECTION_SOURCE
];

function emptyCounters(): TokenSourceCounters {
  return {
    tokens: 0,
    estimatedTokens: 0
  };
}

function addCounters(total: TokenSourceCounters, next: TokenSourceCounters | undefined): TokenSourceCounters {
  if (!next) {
    return total;
  }

  return {
    tokens: total.tokens + Math.max(0, Math.floor(next.tokens)),
    estimatedTokens: total.estimatedTokens + Math.max(0, Math.floor(next.estimatedTokens))
  };
}

function localDayKeyFromDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildDayKeys(period: TokenPeriod, now: Date): string[] {
  const dayCount = period === "today" ? 1 : period === "7d" ? 7 : 30;
  const dayKeys: string[] = [];

  for (let index = dayCount - 1; index >= 0; index -= 1) {
    const date = new Date(now);
    date.setDate(now.getDate() - index);
    dayKeys.push(localDayKeyFromDate(date));
  }

  return dayKeys;
}

function sumSources(
  sourceTotals: Partial<Record<TokenUsageSource, TokenSourceCounters>>,
  sources: TokenUsageSource[]
): TokenSourceCounters {
  return sources.reduce((sum, source) => addCounters(sum, sourceTotals[source]), emptyCounters());
}

export function aggregateTokenStats(
  status: TokenStatsStatus | null | undefined,
  options: {
    period: TokenPeriod;
    narrowViewport: boolean;
    now?: Date;
  }
): TokenAggregateResult {
  const current = status ?? DEFAULT_TOKEN_STATS_STATUS;
  const now = options.now ?? new Date();
  const dayKeys = buildDayKeys(options.period, now);
  const dayLookup = new Map(current.days.map((day) => [day.dayKey, day]));

  const sourceTotals: Partial<Record<TokenUsageSource, TokenSourceCounters>> = {};
  for (const source of TOKEN_USAGE_SOURCES) {
    sourceTotals[source] = emptyCounters();
  }

  let totalTokens = 0;
  let estimatedTokens = 0;

  for (const dayKey of dayKeys) {
    const day = dayLookup.get(dayKey);
    if (!day) {
      continue;
    }

    totalTokens += Math.max(0, Math.floor(day.totalTokens));
    estimatedTokens += Math.max(0, Math.floor(day.estimatedTokens));

    for (const source of TOKEN_USAGE_SOURCES) {
      const daySource = day.bySource[source];
      sourceTotals[source] = addCounters(sourceTotals[source] ?? emptyCounters(), daySource);
    }
  }

  const chatTotals = sumSources(sourceTotals, CHAT_SOURCES);
  const backgroundTotals = sumSources(sourceTotals, BACKGROUND_SOURCES);

  const trendDowngradedOnMobile = options.period === "30d" && options.narrowViewport;
  const trendKeys = trendDowngradedOnMobile ? dayKeys.slice(-7) : dayKeys;
  const trendWindowDays = trendKeys.length;

  const rawTrend = trendKeys.map((dayKey) => {
    const day = dayLookup.get(dayKey);
    return {
      dayKey,
      totalTokens: day?.totalTokens ?? 0,
      estimatedTokens: day?.estimatedTokens ?? 0
    };
  });

  const maxTotal = rawTrend.reduce((max, item) => Math.max(max, item.totalTokens), 0);
  const trendBars: TokenTrendBar[] = rawTrend.map((item) => ({
    ...item,
    heightPercent: maxTotal > 0 ? Math.round((item.totalTokens / maxTotal) * 100) : 0
  }));

  return {
    period: options.period,
    totalTokens,
    estimatedTokens,
    hasEstimated: estimatedTokens > 0,
    lastUpdatedAt: current.lastUpdatedAt,
    sourceTotals: {
      chat: {
        label: "主聊天",
        ...chatTotals
      },
      background: {
        label: "后台任务",
        ...backgroundTotals
      },
      claw: {
        status: current.integrations.claw,
        label: current.integrations.claw === "ready" ? "已接入" : "待接入"
      }
    },
    backgroundDetails: [
      {
        label: "B站兴趣提取",
        ...(sourceTotals[BROWSE_INTEREST_SOURCE] ?? emptyCounters())
      },
      {
        label: "事实提取",
        ...(sourceTotals[BACKGROUND_FACT_EXTRACTION_SOURCE] ?? emptyCounters())
      },
      {
        label: "反思",
        ...(sourceTotals[BACKGROUND_REFLECTION_SOURCE] ?? emptyCounters())
      }
    ],
    trendBars,
    trendWindowDays,
    trendDowngradedOnMobile
  };
}
