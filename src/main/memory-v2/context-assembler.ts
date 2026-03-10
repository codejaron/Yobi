import type {
  BufferMessage,
  Episode,
  Fact,
  KernelStateDocument,
  RelationshipStage,
  UserProfile
} from "@shared/types";
import { estimateTokenCount } from "./token-utils";

export interface ContextAssemblerInput {
  soul: string;
  persona: string;
  stage: RelationshipStage;
  state: KernelStateDocument;
  profile: UserProfile;
  buffer: BufferMessage[];
  facts: Fact[];
  episodes: Episode[];
  maxTokens: number;
  memoryFloorTokens: number;
}

export interface ContextAssemblerOutput {
  system: string;
  selectedFacts: Fact[];
  selectedEpisodes: Episode[];
  maxRecentMessages: number;
}

const RESERVED_RESPONSE_TOKENS = 500;

export function assembleContext(input: ContextAssemblerInput): ContextAssemblerOutput {
  const maxTokens = Math.max(2000, input.maxTokens);
  const block1 = buildIdentityBlock(input.soul, input.persona, input.stage);
  const block1Tokens = estimateTokenCount(block1);
  const stateBlock = buildStateBlock(input.state, input.profile);
  const stateTokens = estimateTokenCount(stateBlock);

  const rawRemaining = Math.max(0, maxTokens - block1Tokens - stateTokens - RESERVED_RESPONSE_TOKENS);
  const memoryBudget = Math.max(0, rawRemaining);

  const selectedFacts: Fact[] = [];
  const selectedEpisodes: Episode[] = [];
  let memoryTokens = 0;
  for (const fact of input.facts) {
    const line = `- ${fact.entity}/${fact.key}: ${fact.value}`;
    const tokens = estimateTokenCount(line) + 6;
    if (memoryTokens + tokens > memoryBudget) {
      break;
    }
    selectedFacts.push(fact);
    memoryTokens += tokens;
  }
  for (const episode of input.episodes) {
    const line = `- ${episode.date}: ${episode.summary}`;
    const tokens = estimateTokenCount(line) + 6;
    if (memoryTokens + tokens > memoryBudget) {
      break;
    }
    selectedEpisodes.push(episode);
    memoryTokens += tokens;
  }

  const memoryBlock = buildMemoryBlock(selectedFacts, selectedEpisodes);
  const memoryBlockTokens = estimateTokenCount(memoryBlock);
  const remainingForMessages = Math.max(
    0,
    maxTokens - block1Tokens - stateTokens - memoryBlockTokens - RESERVED_RESPONSE_TOKENS
  );

  const recentMessages = input.buffer.slice().reverse();
  let recentMessageTokens = 0;
  let maxRecentMessages = 0;
  for (const message of recentMessages) {
    const line = `${message.role === "user" ? "用户" : "Yobi"}: ${message.text}`;
    const nextTokens = estimateTokenCount(line) + 8;
    if (recentMessageTokens + nextTokens > remainingForMessages) {
      break;
    }
    recentMessageTokens += nextTokens;
    maxRecentMessages += 1;
  }

  const system = [block1, stateBlock, memoryBlock].filter(Boolean).join("\n\n");

  return {
    system,
    selectedFacts,
    selectedEpisodes,
    maxRecentMessages: Math.max(1, maxRecentMessages)
  };
}

function buildIdentityBlock(soul: string, persona: string, stage: RelationshipStage): string {
  return [`[SOUL]`, soul.trim(), "", "[PERSONA]", persona.trim(), "", `当前关系阶段: ${stage}`]
    .filter(Boolean)
    .join("\n");
}

function buildStateBlock(state: KernelStateDocument, profile: UserProfile): string {
  const emotional = state.emotional;
  const moodText = emotional.mood >= 0.25 ? "心情偏正向" : emotional.mood <= -0.25 ? "心情偏低落" : "心情中性";
  const energyText = emotional.energy >= 0.65 ? "精力较充沛" : emotional.energy <= 0.3 ? "精力偏低" : "精力中等";
  const sessionReentry = state.sessionReentry?.active
    ? `用户在 ${state.sessionReentry.gapLabel} 后回来了，先自然承接再进入主题。`
    : "";

  return [
    "[STATE]",
    `你现在${moodText}，${energyText}，连接感 ${round2(emotional.connection)}。`,
    `好奇心 ${round2(emotional.curiosity)}，自信 ${round2(emotional.confidence)}，烦躁 ${round2(emotional.irritation)}。`,
    profile.patterns.active_hours ? `用户活跃时段观察：${profile.patterns.active_hours}` : "",
    profile.communication.preferred_comfort_style
      ? `用户安慰偏好：${profile.communication.preferred_comfort_style}`
      : "",
    sessionReentry
  ]
    .filter(Boolean)
    .join("\n");
}

function buildMemoryBlock(facts: Fact[], episodes: Episode[]): string {
  const factLines = facts.map((fact) => `- [Fact] ${fact.entity}/${fact.key}: ${fact.value}`);
  const episodeLines = episodes.map((episode) => `- [Episode] ${episode.date}: ${episode.summary}`);
  const lines = [...factLines, ...episodeLines];
  if (lines.length === 0) {
    return "[MEMORY]\n(无高相关记忆)";
  }
  return `[MEMORY]\n${lines.join("\n")}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
