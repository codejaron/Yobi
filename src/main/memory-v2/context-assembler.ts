import {
  RELATIONSHIP_STAGES,
  type BufferMessage,
  type Episode,
  type Fact,
  type KernelStateDocument,
  type RelationshipGuide,
  type RelationshipStage,
  type UserProfile
} from "@shared/types";
import { estimateTokenCount } from "./token-utils";

export interface ContextAssemblerInput {
  soul: string;
  relationship: RelationshipGuide;
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
  const soulBlock = buildSoulBlock(input.soul);
  const soulTokens = estimateTokenCount(soulBlock);
  const relationshipBlock = buildRelationshipBlock(input.relationship, input.stage);
  const relationshipTokens = estimateTokenCount(relationshipBlock);
  const stateBlock = buildStateBlock(input.state);
  const stateTokens = estimateTokenCount(stateBlock);

  const rawRemaining = Math.max(
    0,
    maxTokens - soulTokens - relationshipTokens - stateTokens - RESERVED_RESPONSE_TOKENS
  );
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
    maxTokens - soulTokens - relationshipTokens - stateTokens - memoryBlockTokens - RESERVED_RESPONSE_TOKENS
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

  const system = [soulBlock, relationshipBlock, stateBlock, memoryBlock].filter(Boolean).join("\n\n");

  return {
    system,
    selectedFacts,
    selectedEpisodes,
    maxRecentMessages: Math.max(1, maxRecentMessages)
  };
}

function buildSoulBlock(soul: string): string {
  return ["[SOUL]", soul.trim()].filter(Boolean).join("\n");
}

function buildRelationshipBlock(relationship: RelationshipGuide, stage: RelationshipStage): string {
  return [
    "[RELATIONSHIP]",
    `current_stage=${stage}`,
    `allowed_values=${JSON.stringify(RELATIONSHIP_STAGES)}`,
    `current_stage_rules=${JSON.stringify(relationship.stages[stage] ?? [])}`
  ]
    .join("\n");
}

function buildStateBlock(state: KernelStateDocument): string {
  const emotional = state.emotional;

  return [
    "[STATE]",
    `mood=${formatSigned(emotional.mood)} range=[-1.00,1.00] higher=more_positive`,
    `energy=${formatUnit(emotional.energy)} range=[0.00,1.00] higher=more_energetic`,
    `connection=${formatUnit(emotional.connection)} range=[0.00,1.00] higher=more_connected`,
    `curiosity=${formatUnit(emotional.curiosity)} range=[0.00,1.00] higher=more_curious`,
    `confidence=${formatUnit(emotional.confidence)} range=[0.00,1.00] higher=more_confident`,
    `irritation=${formatUnit(emotional.irritation)} range=[0.00,1.00] higher=more_irritable`,
    `cold_start=${String(state.coldStart)} values=[true,false]`,
    `session_reentry_active=${String(Boolean(state.sessionReentry?.active))} values=[true,false]`,
    `session_reentry_gap_hours=${state.sessionReentry?.active ? Math.max(0, state.sessionReentry.gapHours) : 0} range=[0,+inf)`
  ]
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

function formatUnit(value: number): string {
  return value.toFixed(2);
}

function formatSigned(value: number): string {
  const normalized = Object.is(value, -0) ? 0 : value;
  return normalized.toFixed(2);
}
