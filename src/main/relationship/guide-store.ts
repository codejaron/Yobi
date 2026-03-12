import {
  DEFAULT_RELATIONSHIP_GUIDE,
  relationshipGuideSchema,
  type RelationshipGuide
} from "@shared/types";
import type { CompanionPaths } from "@main/storage/paths";
import {
  fileExists,
  readJsonFile,
  writeJsonFileAtomic
} from "@main/storage/fs";

export function cloneRelationshipGuide(input: RelationshipGuide): RelationshipGuide {
  return {
    stages: {
      stranger: [...input.stages.stranger],
      acquaintance: [...input.stages.acquaintance],
      familiar: [...input.stages.familiar],
      close: [...input.stages.close],
      intimate: [...input.stages.intimate]
    }
  };
}

export function normalizeRelationshipGuide(input: unknown): RelationshipGuide {
  const parsed = relationshipGuideSchema.safeParse(input);
  const base = parsed.success ? parsed.data : DEFAULT_RELATIONSHIP_GUIDE;

  return {
    stages: {
      stranger: normalizeRules(base.stages.stranger),
      acquaintance: normalizeRules(base.stages.acquaintance),
      familiar: normalizeRules(base.stages.familiar),
      close: normalizeRules(base.stages.close),
      intimate: normalizeRules(base.stages.intimate)
    }
  };
}

export async function loadRelationshipGuide(paths: CompanionPaths): Promise<RelationshipGuide> {
  if (await fileExists(paths.relationshipPath)) {
    const raw = await readJsonFile<unknown>(paths.relationshipPath, null);
    return normalizeRelationshipGuide(raw);
  }

  return cloneRelationshipGuide(DEFAULT_RELATIONSHIP_GUIDE);
}

export async function saveRelationshipGuide(
  paths: CompanionPaths,
  input: RelationshipGuide
): Promise<RelationshipGuide> {
  const normalized = normalizeRelationshipGuide(input);
  await writeJsonFileAtomic(paths.relationshipPath, normalized);
  return normalized;
}

export async function ensureRelationshipGuideFile(paths: CompanionPaths): Promise<RelationshipGuide> {
  if (await fileExists(paths.relationshipPath)) {
    const normalized = await loadRelationshipGuide(paths);
    await writeJsonFileAtomic(paths.relationshipPath, normalized);
    return normalized;
  }

  const fallback = cloneRelationshipGuide(DEFAULT_RELATIONSHIP_GUIDE);
  await writeJsonFileAtomic(paths.relationshipPath, fallback);
  return fallback;
}

function normalizeRules(input: string[]): string[] {
  return input
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}
