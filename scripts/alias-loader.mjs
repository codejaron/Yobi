import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const aliasMap = new Map([
  ["@main/", path.join(root, "out", "src", "main")],
  ["@shared/", path.join(root, "out", "src", "shared")],
  ["@renderer/", path.join(root, "out", "src", "renderer")]
]);

function resolveCompiledPath(targetPath) {
  if (path.extname(targetPath)) {
    return targetPath;
  }

  const fileCandidate = `${targetPath}.js`;
  if (existsSync(fileCandidate)) {
    return fileCandidate;
  }

  const indexCandidate = path.join(targetPath, "index.js");
  if (existsSync(indexCandidate)) {
    return indexCandidate;
  }

  return fileCandidate;
}

export async function resolve(specifier, context, defaultResolve) {
  for (const [prefix, targetDir] of aliasMap.entries()) {
    if (!specifier.startsWith(prefix)) {
      continue;
    }

    const remainder = specifier.slice(prefix.length);
    const resolvedPath = resolveCompiledPath(path.join(targetDir, remainder));
    return {
      url: pathToFileURL(resolvedPath).href,
      shortCircuit: true
    };
  }

  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !path.extname(specifier)) {
    const parentPath = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : root;
    const resolvedPath = resolveCompiledPath(path.resolve(parentPath, specifier));
    return {
      url: pathToFileURL(resolvedPath).href,
      shortCircuit: true
    };
  }

  return defaultResolve(specifier, context, defaultResolve);
}
