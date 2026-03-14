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
  externalFixedTokens?: number;
}

export interface ContextAssemblerOutput {
  system: string;
  selectedFacts: Fact[];
  selectedEpisodes: Episode[];
  maxRecentMessages: number;
}

const RESERVED_RESPONSE_TOKENS = 500;
const SOFT_MIN_BUDGETS = {
  messages: 2000,
  facts: 500,
  episodes: 300
} as const;
const SEGMENT_WEIGHTS = {
  messages: 0.5,
  facts: 0.3,
  episodes: 0.2
} as const;
const PROFILE_LIST_REDUCTION_ORDER = ["catchphrases", "whatFails", "whatWorks", "sensitiveTopics"] as const;

interface ProfileListLimits {
  sensitiveTopics: number;
  whatWorks: number;
  whatFails: number;
  catchphrases: number;
}

interface SelectionResult<T> {
  items: T[];
  usedTokens: number;
  nextIndex: number;
}

interface MessageSelectionResult {
  count: number;
  usedTokens: number;
  nextIndex: number;
}

export function assembleContext(input: ContextAssemblerInput): ContextAssemblerOutput {
  const maxTokens = Math.max(2000, input.maxTokens);
  const memoryFloorTokens = Math.max(0, input.memoryFloorTokens);
  const externalFixedTokens = Math.max(0, input.externalFixedTokens ?? 0);
  const relationshipBlock = buildRelationshipBlock(input.relationship, input.stage);
  const stateBlock = buildStateBlock(input.state);
  let soulBlock = buildSoulBlock(input.soul);
  let profileLimits = defaultProfileListLimits();
  let profileBlock = buildProfileBlock(input.profile, profileLimits);

  let allocatable = computeAllocatableTokens({
    maxTokens,
    externalFixedTokens,
    soulBlock,
    relationshipBlock,
    stateBlock,
    profileBlock
  });

  while (allocatable < memoryFloorTokens) {
    const nextLimits = reduceProfileLimits(profileLimits, input.profile);
    if (!nextLimits) {
      break;
    }
    profileLimits = nextLimits;
    profileBlock = buildProfileBlock(input.profile, profileLimits);
    allocatable = computeAllocatableTokens({
      maxTokens,
      externalFixedTokens,
      soulBlock,
      relationshipBlock,
      stateBlock,
      profileBlock
    });
  }

  if (allocatable < memoryFloorTokens) {
    const nonSoulFixedTokens = estimateJoinedTokens([relationshipBlock, stateBlock, profileBlock]);
    const availableSoulTokens = Math.max(
      estimateTokenCount("[SOUL]\n[SOUL_TRUNCATED]"),
      maxTokens - externalFixedTokens - RESERVED_RESPONSE_TOKENS - nonSoulFixedTokens - memoryFloorTokens
    );
    soulBlock = truncateSoulBlock(input.soul, availableSoulTokens);
    allocatable = computeAllocatableTokens({
      maxTokens,
      externalFixedTokens,
      soulBlock,
      relationshipBlock,
      stateBlock,
      profileBlock
    });
  }

  const segmentBudgets = allocateSegmentBudgets(Math.max(0, allocatable));
  const recentMessages = input.buffer.slice().reverse();

  let messageSelection = selectRecentMessages(recentMessages, 0, segmentBudgets.messages);
  let factSelection = selectItems(input.facts, 0, segmentBudgets.facts, estimateFactLineTokens);
  let episodeSelection = selectItems(input.episodes, 0, segmentBudgets.episodes, estimateEpisodeLineTokens);

  let unusedTokens =
    Math.max(0, segmentBudgets.messages - messageSelection.usedTokens) +
    Math.max(0, segmentBudgets.facts - factSelection.usedTokens) +
    Math.max(0, segmentBudgets.episodes - episodeSelection.usedTokens);

  if (unusedTokens > 0) {
    const expandedMessages = selectRecentMessages(recentMessages, messageSelection.nextIndex, unusedTokens);
    messageSelection = {
      count: messageSelection.count + expandedMessages.count,
      usedTokens: messageSelection.usedTokens + expandedMessages.usedTokens,
      nextIndex: expandedMessages.nextIndex
    };
    unusedTokens -= expandedMessages.usedTokens;
  }

  if (unusedTokens > 0) {
    const expandedFacts = selectItems(input.facts, factSelection.nextIndex, unusedTokens, estimateFactLineTokens);
    factSelection = {
      items: [...factSelection.items, ...expandedFacts.items],
      usedTokens: factSelection.usedTokens + expandedFacts.usedTokens,
      nextIndex: expandedFacts.nextIndex
    };
    unusedTokens -= expandedFacts.usedTokens;
  }

  if (unusedTokens > 0) {
    const expandedEpisodes = selectItems(
      input.episodes,
      episodeSelection.nextIndex,
      unusedTokens,
      estimateEpisodeLineTokens
    );
    episodeSelection = {
      items: [...episodeSelection.items, ...expandedEpisodes.items],
      usedTokens: episodeSelection.usedTokens + expandedEpisodes.usedTokens,
      nextIndex: expandedEpisodes.nextIndex
    };
  }

  const memoryBlock = buildMemoryBlock(factSelection.items, episodeSelection.items);
  const system = [soulBlock, relationshipBlock, stateBlock, profileBlock, memoryBlock].filter(Boolean).join("\n\n");

  return {
    system,
    selectedFacts: factSelection.items,
    selectedEpisodes: episodeSelection.items,
    maxRecentMessages: Math.max(1, messageSelection.count)
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
  ].join("\n");
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
    `session_reentry_active=${String(Boolean(state.sessionReentry?.active))} values=[true,false]`,
    `session_reentry_gap_hours=${state.sessionReentry?.active ? Math.max(0, state.sessionReentry.gapHours) : 0} range=[0,+inf)`
  ].join("\n");
}

function buildProfileBlock(profile: UserProfile, limits: ProfileListLimits): string {
  const lines = [
    "[PROFILE]",
    `消息风格=${profile.communication.avg_message_length}`,
    `emoji=${profile.communication.emoji_usage}`,
    `幽默接受度=${formatUnit(profile.communication.humor_receptivity)}`,
    `建议接受度=${formatUnit(profile.communication.advice_receptivity)}`,
    `情感开放度=${formatUnit(profile.communication.emotional_openness)}`
  ];

  if (profile.communication.preferred_comfort_style) {
    lines.push(`安慰偏好=${profile.communication.preferred_comfort_style}`);
  }

  if (profile.patterns.active_hours) {
    lines.push(`活跃时段=${profile.patterns.active_hours}`);
  }

  const sensitiveTopics = profile.interaction_notes.sensitive_topics.slice(0, limits.sensitiveTopics);
  if (sensitiveTopics.length > 0) {
    lines.push(`敏感话题=${JSON.stringify(sensitiveTopics)}`);
  }

  const whatWorks = profile.interaction_notes.what_works.slice(0, limits.whatWorks);
  if (whatWorks.length > 0) {
    lines.push(`有效策略=${JSON.stringify(whatWorks)}`);
  }

  const whatFails = profile.interaction_notes.what_fails.slice(0, limits.whatFails);
  if (whatFails.length > 0) {
    lines.push(`无效策略=${JSON.stringify(whatFails)}`);
  }

  const catchphrases = profile.communication.catchphrases.slice(0, limits.catchphrases);
  if (catchphrases.length > 0) {
    lines.push(`口头禅=${JSON.stringify(catchphrases)}`);
  }

  return lines.join("\n");
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

function computeAllocatableTokens(input: {
  maxTokens: number;
  externalFixedTokens: number;
  soulBlock: string;
  relationshipBlock: string;
  stateBlock: string;
  profileBlock: string;
}): number {
  const fixedTokens = estimateJoinedTokens([
    input.soulBlock,
    input.relationshipBlock,
    input.stateBlock,
    input.profileBlock
  ]);
  return Math.max(0, input.maxTokens - fixedTokens - input.externalFixedTokens - RESERVED_RESPONSE_TOKENS);
}

function estimateJoinedTokens(blocks: string[]): number {
  const content = blocks.filter(Boolean).join("\n\n");
  if (!content) {
    return 0;
  }
  return estimateTokenCount(content);
}

function defaultProfileListLimits(): ProfileListLimits {
  return {
    sensitiveTopics: 5,
    whatWorks: 5,
    whatFails: 5,
    catchphrases: 5
  };
}

function reduceProfileLimits(limits: ProfileListLimits, profile: UserProfile): ProfileListLimits | null {
  for (const key of PROFILE_LIST_REDUCTION_ORDER) {
    if (limits[key] <= 0 || getProfileListSize(profile, key) === 0) {
      continue;
    }
    return {
      ...limits,
      [key]: limits[key] - 1
    };
  }
  return null;
}

function getProfileListSize(profile: UserProfile, key: keyof ProfileListLimits): number {
  if (key === "sensitiveTopics") {
    return profile.interaction_notes.sensitive_topics.length;
  }
  if (key === "whatWorks") {
    return profile.interaction_notes.what_works.length;
  }
  if (key === "whatFails") {
    return profile.interaction_notes.what_fails.length;
  }
  return profile.communication.catchphrases.length;
}

function truncateSoulBlock(soul: string, maxTokens: number): string {
  const fullBlock = buildSoulBlock(soul);
  if (estimateTokenCount(fullBlock) <= maxTokens) {
    return fullBlock;
  }

  const paragraphs = soul
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const marker = "[SOUL_TRUNCATED]";
  const kept: string[] = [];

  for (const paragraph of paragraphs) {
    const nextText = [...kept, paragraph, marker].join("\n\n");
    if (estimateTokenCount(buildSoulBlock(nextText)) > maxTokens) {
      break;
    }
    kept.push(paragraph);
  }

  if (kept.length > 0) {
    return buildSoulBlock([...kept, marker].join("\n\n"));
  }

  const normalized = soul.trim();
  if (!normalized) {
    return buildSoulBlock(marker);
  }

  let low = 0;
  let high = normalized.length;
  let best = marker;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = `${normalized.slice(0, mid).trim()}... ${marker}`.trim();
    if (estimateTokenCount(buildSoulBlock(candidate)) <= maxTokens) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return buildSoulBlock(best);
}

function allocateSegmentBudgets(allocatableTokens: number): {
  messages: number;
  facts: number;
  episodes: number;
} {
  if (allocatableTokens <= 0) {
    return {
      messages: 0,
      facts: 0,
      episodes: 0
    };
  }

  const softMinTotal =
    SOFT_MIN_BUDGETS.messages + SOFT_MIN_BUDGETS.facts + SOFT_MIN_BUDGETS.episodes;
  if (allocatableTokens < softMinTotal) {
    return allocateWeighted(allocatableTokens);
  }

  const extra = allocateWeighted(allocatableTokens - softMinTotal);
  return {
    messages: SOFT_MIN_BUDGETS.messages + extra.messages,
    facts: SOFT_MIN_BUDGETS.facts + extra.facts,
    episodes: SOFT_MIN_BUDGETS.episodes + extra.episodes
  };
}

function allocateWeighted(total: number): {
  messages: number;
  facts: number;
  episodes: number;
} {
  const rawEntries = [
    {
      key: "messages" as const,
      value: total * SEGMENT_WEIGHTS.messages
    },
    {
      key: "facts" as const,
      value: total * SEGMENT_WEIGHTS.facts
    },
    {
      key: "episodes" as const,
      value: total * SEGMENT_WEIGHTS.episodes
    }
  ];
  const budgets = {
    messages: Math.floor(rawEntries[0].value),
    facts: Math.floor(rawEntries[1].value),
    episodes: Math.floor(rawEntries[2].value)
  };

  let remainder = Math.max(0, total - budgets.messages - budgets.facts - budgets.episodes);
  const byFraction = rawEntries
    .map((entry) => ({
      key: entry.key,
      fraction: entry.value - Math.floor(entry.value)
    }))
    .sort((left, right) => right.fraction - left.fraction);

  for (const entry of byFraction) {
    if (remainder <= 0) {
      break;
    }
    budgets[entry.key] += 1;
    remainder -= 1;
  }

  return budgets;
}

function selectItems<T>(
  items: T[],
  startIndex: number,
  budgetTokens: number,
  estimateTokens: (item: T) => number
): SelectionResult<T> {
  const selected: T[] = [];
  let usedTokens = 0;
  let index = startIndex;

  for (; index < items.length; index += 1) {
    const tokens = estimateTokens(items[index]);
    if (usedTokens + tokens > budgetTokens) {
      break;
    }
    selected.push(items[index]);
    usedTokens += tokens;
  }

  return {
    items: selected,
    usedTokens,
    nextIndex: index
  };
}

function selectRecentMessages(
  messages: BufferMessage[],
  startIndex: number,
  budgetTokens: number
): MessageSelectionResult {
  let usedTokens = 0;
  let count = 0;
  let index = startIndex;

  for (; index < messages.length; index += 1) {
    const nextTokens = estimateMessageLineTokens(messages[index]);
    if (usedTokens + nextTokens > budgetTokens) {
      break;
    }
    usedTokens += nextTokens;
    count += 1;
  }

  return {
    count,
    usedTokens,
    nextIndex: index
  };
}

function estimateFactLineTokens(fact: Fact): number {
  return estimateTokenCount(`- [Fact] ${fact.entity}/${fact.key}: ${fact.value}`) + 6;
}

function estimateEpisodeLineTokens(episode: Episode): number {
  return estimateTokenCount(`- [Episode] ${episode.date}: ${episode.summary}`) + 6;
}

function estimateMessageLineTokens(message: BufferMessage): number {
  return estimateTokenCount(`${message.role === "user" ? "用户" : "Yobi"}: ${message.text}`) + 8;
}

function formatUnit(value: number): string {
  return value.toFixed(2);
}

function formatSigned(value: number): string {
  const normalized = Object.is(value, -0) ? 0 : value;
  return normalized.toFixed(2);
}
