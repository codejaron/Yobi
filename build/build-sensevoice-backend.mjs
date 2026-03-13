import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, realpath, rm } from "node:fs/promises";

const VERSION = process.env.SENSEVOICE_VERSION?.trim() || "v1.4.0";
const REPO_URL = process.env.SENSEVOICE_REPO_URL?.trim() || "https://github.com/lovemefan/SenseVoice.cpp";
const SOURCE_OVERRIDE = process.env.SENSEVOICE_SOURCE_DIR?.trim() || "";

function platformConfig() {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return {
      key: "darwin-arm64",
      binaryName: "sense-voice-main",
      dependencyPattern: /^libggml.*\.dylib$/i
    };
  }

  if (process.platform === "win32" && process.arch === "x64") {
    return {
      key: "win32-x64",
      binaryName: "sense-voice-main.exe",
      dependencyPattern: /^(lib)?ggml.*\.(dll)$/i
    };
  }

  throw new Error(`Unsupported SenseVoice build host: ${process.platform}-${process.arch}`);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
      ...options
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}`));
    });
    child.on("error", reject);
  });
}

async function findFiles(rootDir, matcher) {
  const matches = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }

    const entries = await import("node:fs/promises").then((mod) => mod.readdir(current, { withFileTypes: true }));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (matcher(entry.name, fullPath)) {
        matches.push(fullPath);
      }
    }
  }

  return matches;
}

async function ensureLocalRepo(workDir) {
  if (SOURCE_OVERRIDE) {
    return SOURCE_OVERRIDE;
  }

  const repoDir = path.join(workDir, "SenseVoice.cpp");
  await runCommand("git", [
    "clone",
    "--branch",
    VERSION,
    "--depth",
    "1",
    "--recurse-submodules",
    "--shallow-submodules",
    REPO_URL,
    repoDir
  ]);
  return repoDir;
}

async function buildRepo(repoDir) {
  await runCommand("cmake", ["-B", "build", "-DCMAKE_BUILD_TYPE=Release"], {
    cwd: repoDir
  });
  await runCommand("cmake", ["--build", "build", "--config", "Release", "--parallel", "8"], {
    cwd: repoDir
  });
}

async function patchDarwinRpaths(binaryPath, dependencyPaths, oldRpath) {
  await runCommand("install_name_tool", ["-delete_rpath", oldRpath, "-add_rpath", "@executable_path", binaryPath]).catch(() => undefined);

  for (const dependencyPath of dependencyPaths) {
    await runCommand("install_name_tool", ["-add_rpath", "@loader_path", dependencyPath]).catch(() => undefined);
  }
}

async function copyArtifacts(repoDir, rootDir) {
  const config = platformConfig();
  const buildDir = path.join(repoDir, "build");
  const targetDir = path.join(rootDir, "resources", "sensevoice", "bin", config.key);
  await mkdir(targetDir, { recursive: true });

  const binaryMatches = await findFiles(buildDir, (name) => name === config.binaryName);
  const binarySource = binaryMatches[0];
  if (!binarySource) {
    throw new Error(`Failed to locate ${config.binaryName} in ${buildDir}`);
  }

  const dependencyMatches = await findFiles(buildDir, (name) => config.dependencyPattern.test(name));

  const binaryTarget = path.join(targetDir, config.binaryName);
  await cp(binarySource, binaryTarget, { force: true });

  const dependencyTargets = [];
  for (const dependencySource of dependencyMatches) {
    const dependencyTarget = path.join(targetDir, path.basename(dependencySource));
    await cp(dependencySource, dependencyTarget, { force: true });
    dependencyTargets.push(dependencyTarget);
  }

  if (process.platform === "darwin") {
    await runCommand("chmod", ["+x", binaryTarget]);
    await patchDarwinRpaths(binaryTarget, dependencyTargets, await realpath(path.join(buildDir, "lib")));
  }

  console.log(`[sensevoice-build] copied backend to ${targetDir}`);
}

async function main() {
  const projectRoot = process.cwd();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "yobi-sensevoice-build-"));

  try {
    const repoDir = await ensureLocalRepo(tempDir);
    if (!existsSync(repoDir)) {
      throw new Error(`SenseVoice source directory not found: ${repoDir}`);
    }
    await buildRepo(repoDir);
    await copyArtifacts(repoDir, projectRoot);
  } finally {
    if (!SOURCE_OVERRIDE) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[sensevoice-build] failed: ${message}`);
  process.exitCode = 1;
});
