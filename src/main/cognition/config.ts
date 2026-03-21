import type { CompanionPaths } from "@main/storage/paths";
import { readJsonFile, writeJsonFileAtomic } from "@main/storage/fs";
import {
  cognitionConfigSchema,
  DEFAULT_COGNITION_CONFIG,
  type CognitionConfig,
  type CognitionConfigPatch
} from "@shared/cognition";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as T;
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    next[key] = cloneValue(child);
  }
  return next as T;
}

function mergeConfigValue<T>(base: T, patch: unknown): T {
  if (Array.isArray(base)) {
    return Array.isArray(patch) ? cloneValue(patch) as T : cloneValue(base);
  }

  if (!isPlainObject(base)) {
    return patch === undefined ? cloneValue(base) : patch as T;
  }

  const source = isPlainObject(patch) ? patch : {};
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    next[key] = mergeConfigValue(value, source[key]);
  }
  return next as T;
}

function normalizeCognitionConfig(raw: unknown): CognitionConfig {
  const merged = mergeConfigValue(DEFAULT_COGNITION_CONFIG, raw);
  return cognitionConfigSchema.parse(merged);
}

export async function loadCognitionConfig(paths: CompanionPaths): Promise<CognitionConfig> {
  const raw = await readJsonFile<unknown>(paths.cognitionConfigPath, null);
  const config = normalizeCognitionConfig(raw);
  await writeJsonFileAtomic(paths.cognitionConfigPath, config);
  return config;
}

export async function saveCognitionConfig(paths: CompanionPaths, config: CognitionConfig): Promise<CognitionConfig> {
  const normalized = normalizeCognitionConfig(config);
  await writeJsonFileAtomic(paths.cognitionConfigPath, normalized);
  return normalized;
}

export async function patchCognitionConfig(
  paths: CompanionPaths,
  current: CognitionConfig,
  patch: CognitionConfigPatch
): Promise<CognitionConfig> {
  const next = normalizeCognitionConfig(mergeConfigValue(current, patch));
  await writeJsonFileAtomic(paths.cognitionConfigPath, next);
  return next;
}
