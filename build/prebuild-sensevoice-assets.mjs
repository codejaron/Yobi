import path from "node:path";
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const targets = [
  {
    key: "darwin-arm64",
    envName: "SENSEVOICE_DARWIN_ARM64_PATH",
    fileName: "sense-voice-main"
  },
  {
    key: "win32-x64",
    envName: "SENSEVOICE_WIN32_X64_PATH",
    fileName: "sense-voice-main.exe"
  }
];

function currentTargetKey() {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "darwin-arm64";
  }

  if (process.platform === "win32" && process.arch === "x64") {
    return "win32-x64";
  }

  return null;
}

async function ensureTarget(target) {
  const targetDir = path.join(projectRoot, "resources", "sensevoice", "bin", target.key);
  const targetPath = path.join(targetDir, target.fileName);

  await mkdir(targetDir, { recursive: true });

  const sourcePath = process.env[target.envName]?.trim();
  if (sourcePath) {
    await copyFile(sourcePath, targetPath);
    console.log(`[sensevoice-assets] copied ${target.envName} -> ${targetPath}`);
    return;
  }

  if (existsSync(targetPath)) {
    console.log(`[sensevoice-assets] reusing existing asset at ${targetPath}`);
    return;
  }

  console.warn(`[sensevoice-assets] missing ${target.key} backend at ${targetPath}`);
}

async function main() {
  const selectedTargets =
    process.env.SENSEVOICE_VALIDATE_ALL === "1"
      ? targets
      : (() => {
          const key = currentTargetKey();
          return key ? targets.filter((target) => target.key === key) : [];
        })();

  for (const target of selectedTargets) {
    await ensureTarget(target);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[sensevoice-assets] prebuild failed: ${message}`);
  process.exitCode = 1;
});
