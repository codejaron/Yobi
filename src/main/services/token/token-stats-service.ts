import type { TokenStatsStatus, TokenUsageSource } from "@shared/types";
import { parseUsageTokens, estimateTokensFromText } from "./token-usage-utils";
import { TokenStatsStore } from "./token-stats-store";

export interface TokenUsageRecordInput {
  source: TokenUsageSource;
  usage?: unknown;
  inputText?: string;
  outputText?: string;
  systemText?: string;
  timestamp?: string | number | Date | null;
}

export class TokenStatsService {
  constructor(private readonly store: TokenStatsStore) {}

  async record(input: TokenUsageRecordInput): Promise<void> {
    const parsedUsage = parseUsageTokens(input.usage);
    let tokens = parsedUsage.tokens;
    let estimatedTokens = 0;

    if (tokens <= 0) {
      tokens = estimateTokensFromText(input.inputText, input.outputText, input.systemText);
      estimatedTokens = tokens;
    }

    if (tokens <= 0) {
      return;
    }

    await this.store.record({
      source: input.source,
      tokens,
      estimatedTokens,
      timestamp: input.timestamp
    });
  }

  async getStatus(): Promise<TokenStatsStatus> {
    return this.store.getStatus();
  }
}
