import type {
  SkillCatalogItem,
  SkillsCatalogSummary
} from "@shared/types";
import { estimateTokenCount } from "@main/memory-v2/token-utils";

export interface SkillsCatalogBuildResult {
  prompt: string;
  summary: SkillsCatalogSummary;
}

const SKILL_CATALOG_RULES = [
  "[SKILL CATALOG]",
  "以下是当前已启用的 skills。若某个 skill 看起来与当前任务相关，先调用 activate_skill(skillId)，再遵循该 skill 指令。",
  "不要假设未激活 skill 的全文内容。"
].join("\n");

const TRUNCATION_NOTE_TEMPLATE = '<CATALOG_TRUNCATED truncated_descriptions="9999" omitted_skills="9999" />';

export function buildSkillsCatalogPrompt(skills: SkillCatalogItem[], budgetTokens = 10_000): SkillsCatalogBuildResult {
  const enabled = skills
    .filter((item) => item.enabled)
    .slice()
    .sort((left, right) => {
      const byName = left.name.localeCompare(right.name, "zh-CN");
      return byName !== 0 ? byName : left.id.localeCompare(right.id, "zh-CN");
    });

  const closing = "</available_skills>";
  const truncationReserve = estimateTokenCount(TRUNCATION_NOTE_TEMPLATE);
  const fixedPrefix = `${SKILL_CATALOG_RULES}\n<available_skills>`;
  const fixedTokenCost = estimateTokenCount(fixedPrefix) + estimateTokenCount(closing) + truncationReserve;
  const tokenBudget = Math.max(0, budgetTokens - fixedTokenCost);

  let usedTokens = 0;
  let truncatedDescriptions = 0;
  let omittedSkills = 0;
  const lines: string[] = [];

  for (const skill of enabled) {
    const compact = renderCompactSkill(skill);
    const compactTokens = estimateTokenCount(compact);

    if (usedTokens + compactTokens > tokenBudget) {
      omittedSkills += 1;
      continue;
    }

    const full = renderFullSkill(skill, skill.description);
    const fullTokens = estimateTokenCount(full);
    if (usedTokens + fullTokens <= tokenBudget) {
      lines.push(full);
      usedTokens += fullTokens;
      continue;
    }

    const remaining = tokenBudget - usedTokens;
    const truncatedDescription = fitDescription(skill, remaining);
    if (truncatedDescription) {
      const truncated = renderFullSkill(skill, `${truncatedDescription} ...[truncated]`);
      lines.push(truncated);
      usedTokens += estimateTokenCount(truncated);
      truncatedDescriptions += 1;
      continue;
    }

    lines.push(compact);
    usedTokens += compactTokens;
    truncatedDescriptions += 1;
  }

  const summary: SkillsCatalogSummary = {
    enabledCount: enabled.length,
    truncated: truncatedDescriptions > 0 || omittedSkills > 0,
    truncatedDescriptions,
    omittedSkills
  };

  const truncationNote = summary.truncated
    ? `<CATALOG_TRUNCATED truncated_descriptions="${summary.truncatedDescriptions}" omitted_skills="${summary.omittedSkills}" />\n`
    : "";
  const prompt = `${SKILL_CATALOG_RULES}\n${truncationNote}<available_skills>\n${lines.join("\n")}\n${closing}`;

  return {
    prompt,
    summary
  };
}

function renderCompactSkill(skill: SkillCatalogItem): string {
  return `  <skill id="${escapeAttribute(skill.id)}" name="${escapeAttribute(skill.name)}" />`;
}

function renderFullSkill(skill: SkillCatalogItem, description: string): string {
  return [
    `  <skill id="${escapeAttribute(skill.id)}" name="${escapeAttribute(skill.name)}">`,
    `    ${description.trim()}`,
    "  </skill>"
  ].join("\n");
}

function fitDescription(skill: SkillCatalogItem, remainingTokens: number): string {
  const trimmed = skill.description.trim();
  if (!trimmed) {
    return "";
  }

  let low = 1;
  let high = trimmed.length;
  let best = "";

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = renderFullSkill(skill, `${trimmed.slice(0, mid).trimEnd()} ...[truncated]`);
    const tokens = estimateTokenCount(candidate);
    if (tokens <= remainingTokens) {
      best = trimmed.slice(0, mid).trimEnd();
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
