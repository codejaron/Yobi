import fs from "node:fs";
import path from "node:path";

export interface PetExpressionOption {
  id: string;
  label: string;
}

export interface PetModelMetadata {
  expressions: PetExpressionOption[];
}

type Model3Json = {
  FileReferences?: {
    Textures?: string[];
    Expressions?: Array<{
      Name?: string;
      File?: string;
    }>;
  };
};

export function getPetModelMetadata(modelDir: string): PetModelMetadata {
  const modelJsonPath = findPetModelJsonPath(modelDir);
  if (!modelJsonPath) {
    return {
      expressions: []
    };
  }

  try {
    const raw = fs.readFileSync(modelJsonPath, "utf8");
    const parsed = JSON.parse(raw) as Model3Json;
    const definitions = Array.isArray(parsed?.FileReferences?.Expressions) ? parsed.FileReferences.Expressions : [];
    const seen = new Set<string>();
    const expressions: PetExpressionOption[] = [];

    for (const definition of definitions) {
      const id = typeof definition?.Name === "string" ? definition.Name.trim() : "";
      if (!id || seen.has(id)) {
        continue;
      }

      seen.add(id);
      expressions.push({
        id,
        label: id
      });
    }

    return {
      expressions
    };
  } catch {
    return {
      expressions: []
    };
  }
}

export function findPetModelJsonPath(modelDir: string): string | null {
  const candidateDirs = buildPetModelCandidateDirs(modelDir);
  for (const dir of candidateDirs) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".model3.json")) {
        continue;
      }
      return path.join(dir, entry.name);
    }
  }

  return null;
}

export function findPetFallbackImagePath(modelJsonPath: string): string | null {
  try {
    const raw = fs.readFileSync(modelJsonPath, "utf8");
    const parsed = JSON.parse(raw) as Model3Json;
    const modelBaseDir = path.dirname(modelJsonPath);
    const textures = Array.isArray(parsed?.FileReferences?.Textures) ? parsed.FileReferences.Textures : [];
    for (const texture of textures) {
      if (typeof texture !== "string" || !texture.trim()) {
        continue;
      }
      const candidate = path.join(modelBaseDir, texture);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {}

  const candidateDirs = buildPetModelCandidateDirs(path.dirname(modelJsonPath));
  for (const dir of candidateDirs) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!/texture_\d+\.png$/i.test(entry.name) && !/\.png$/i.test(entry.name)) {
        continue;
      }
      return path.join(dir, entry.name);
    }
  }

  return null;
}

export function buildPetModelCandidateDirs(baseDir: string): string[] {
  const candidates = [baseDir, path.join(baseDir, "runtime")];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return candidates;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const childDir = path.join(baseDir, entry.name);
    candidates.push(childDir, path.join(childDir, "runtime"));
  }

  return Array.from(new Set(candidates));
}
