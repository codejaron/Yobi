import type {
  BufferMessage,
  Episode,
  Fact,
  KernelStateDocument,
  RelationshipStage,
  UserProfile
} from "@shared/types";
import { extractQueryTerms, matchEpisodes, matchFacts } from "./retrieval";

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
}

export interface ContextAssemblerOutput {
  system: string;
  selectedFacts: Fact[];
  selectedEpisodes: Episode[];
}

const TARGET_STATE_BLOCK_TOKENS = 500;

export function assembleContext(input: ContextAssemblerInput): ContextAssemblerOutput {
  const maxTokens = Math.max(2000, input.maxTokens);
  const block1 = buildIdentityBlock(input.soul, input.persona, input.stage);
  const block1Tokens = estimateTokens(block1);

  const bufferMessages = input.buffer.slice().reverse();
  const selectedBuffer: BufferMessage[] = [];
  let bufferTokens = 0;
  const bufferBudget = Math.max(400, maxTokens - block1Tokens - TARGET_STATE_BLOCK_TOKENS);
  for (const message of bufferMessages) {
    const line = `${message.role === "user" ? "用户" : "Yobi"}: ${message.text}`;
    const nextTokens = estimateTokens(line) + 8;
    if (bufferTokens + nextTokens > bufferBudget) {
      break;
    }
    selectedBuffer.push(message);
    bufferTokens += nextTokens;
  }
  selectedBuffer.reverse();

  const stateBlock = buildStateBlock(input.state, input.profile);
  const stateTokens = estimateTokens(stateBlock);

  const queryTerms = extractQueryTerms(
    selectedBuffer
      .filter((item) => item.role === "user")
      .slice(-3)
      .map((item) => item.text)
  );

  const remainingForMemory = Math.max(0, maxTokens - block1Tokens - bufferTokens - stateTokens);
  const factsMatched = matchFacts(input.facts, queryTerms, 20);
  const episodesMatched = matchEpisodes(input.episodes, queryTerms, 8);

  const selectedFacts: Fact[] = [];
  const selectedEpisodes: Episode[] = [];
  let memoryTokens = 0;
  for (const row of factsMatched) {
    const line = `- ${row.fact.entity}/${row.fact.key}: ${row.fact.value}`;
    const tokens = estimateTokens(line) + 6;
    if (memoryTokens + tokens > remainingForMemory) {
      break;
    }
    selectedFacts.push(row.fact);
    memoryTokens += tokens;
  }
  for (const row of episodesMatched) {
    const line = `- ${row.episode.date}: ${row.episode.summary}`;
    const tokens = estimateTokens(line) + 6;
    if (memoryTokens + tokens > remainingForMemory) {
      break;
    }
    selectedEpisodes.push(row.episode);
    memoryTokens += tokens;
  }

  const memoryBlock = buildMemoryBlock(selectedFacts, selectedEpisodes);
  const conversationBlock = selectedBuffer
    .map((message) => `${message.role === "user" ? "用户" : "Yobi"}: ${message.text}`)
    .join("\n");

  const system = [block1, stateBlock, memoryBlock, `最近对话:\n${conversationBlock || "(空)"}`]
    .filter(Boolean)
    .join("\n\n");

  return {
    system,
    selectedFacts,
    selectedEpisodes
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

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 2));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
