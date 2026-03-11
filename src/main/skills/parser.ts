import path from "node:path";
import yaml from "js-yaml";
import type {
  SkillCatalogItem,
  SkillCompatibility,
  SkillResourceEntry
} from "@shared/types";

interface ParsedFrontmatter {
  metadata: Record<string, unknown>;
  body: string;
}

const SUPPORTED_RESOURCE_DIRS = new Set(["scripts", "references", "assets", "templates"]);
const PARTIAL_KEYS = new Set(["allowed-tools", "allowedTools", "input", "model"]);

export interface ParsedSkillCatalogInput {
  id: string;
  directoryPath: string;
  markdownPath: string;
  markdownHead: string;
  resourceEntries: SkillResourceEntry[];
}

export function parseSkillCatalogItem(input: ParsedSkillCatalogInput): SkillCatalogItem {
  const { metadata, body } = extractFrontmatter(input.markdownHead);
  const issues: string[] = [];

  for (const key of Object.keys(metadata)) {
    if (PARTIAL_KEYS.has(key)) {
      issues.push(`暂未原生支持 frontmatter 字段: ${key}`);
    }
  }

  const metadataName = asNonEmptyString(metadata.name);
  const metadataDescription = asNonEmptyString(metadata.description);
  const name = metadataName || input.id;
  const description = metadataDescription || firstSummaryParagraph(body) || "未提供描述。";
  const version = normalizeVersion(metadata.version);
  const tags = normalizeTags(metadata.tags);

  let compatibility: SkillCompatibility = {
    status: issues.length > 0 ? "partial" : "compatible",
    issues
  };

  if (!name.trim() || !description.trim()) {
    compatibility = {
      status: "invalid",
      issues: [...issues, "无法解析 skill 名称或描述"]
    };
  }

  return {
    id: input.id,
    name,
    description,
    version,
    tags,
    enabled: true,
    directoryPath: input.directoryPath,
    markdownPath: input.markdownPath,
    compatibility,
    resourceEntries: input.resourceEntries
      .filter((entry) => SUPPORTED_RESOURCE_DIRS.has(entry.relativePath.split("/")[0] ?? ""))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath, "zh-CN")),
    metadata,
    markdownPreview: null
  };
}

export function normalizeSkillId(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "skill";
}

export function firstSummaryParagraph(markdown: string): string {
  const paragraphs = markdown
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/g)
    .filter((chunk) => !isHeadingOnlyParagraph(chunk))
    .map((chunk) => normalizeParagraph(chunk))
    .filter(Boolean);

  return paragraphs[0] ?? "";
}

function isHeadingOnlyParagraph(input: string): boolean {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.length > 0 && lines.every((line) => line.startsWith("#"));
}

export function trimPreview(markdown: string, maxChars = 2000): string {
  const trimmed = markdown.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxChars)}\n...[truncated]`;
}

export function groupResources(entries: SkillResourceEntry[]): Record<string, string[]> {
  return entries.reduce<Record<string, string[]>>(
    (result, entry) => {
      const key = `${entry.kind}s`;
      result[key] = result[key] ?? [];
      result[key].push(entry.relativePath);
      return result;
    },
    {
      scripts: [],
      references: [],
      assets: [],
      templates: []
    }
  );
}

function extractFrontmatter(markdown: string): ParsedFrontmatter {
  const normalized = markdown.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!match) {
    return {
      metadata: {},
      body: normalized
    };
  }

  try {
    const parsed = yaml.load(match[1]);
    const metadata = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {};

    return {
      metadata,
      body: normalized.slice(match[0].length)
    };
  } catch {
    return {
      metadata: {},
      body: normalized
    };
  }
}

function normalizeParagraph(input: string): string {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("```"));

  const joined = lines
    .map((line) => line.replace(/^#+\s*/, ""))
    .map((line) => line.replace(/^[-*+]\s+/, ""))
    .join(" ")
    .replace(/[`*_>#]/g, "")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  if (!joined) {
    return "";
  }

  if (joined === path.basename(joined)) {
    return joined;
  }

  return joined;
}

function normalizeVersion(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
