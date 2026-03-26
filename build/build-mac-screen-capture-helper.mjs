import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";

function executableName() {
  return process.platform === "win32" ? "yobi-mac-screen-capture.exe" : "yobi-mac-screen-capture";
}

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}`));
    });
  });
}

async function main() {
  if (process.platform !== "darwin") {
    console.log("[mac-capture-helper] skipped on non-macOS host");
    return;
  }

  const projectRoot = process.cwd();
  const sourcePath = path.join(projectRoot, "resources", "mac-screen-capture", "src", "main.swift");
  const moduleCachePath = path.join(os.tmpdir(), "yobi-swift-module-cache");
  const outputDir = path.join(projectRoot, "resources", "mac-screen-capture", "bin", platformKey());
  const outputPath = path.join(outputDir, executableName());
  await mkdir(moduleCachePath, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await runCommand("xcrun", [
    "swiftc",
    "-parse-as-library",
    "-module-cache-path",
    moduleCachePath,
    "-O",
    "-o",
    outputPath,
    sourcePath
  ]);
  await chmod(outputPath, 0o755);
  console.log(`[mac-capture-helper] built ${outputPath}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[mac-capture-helper] failed: ${message}`);
  process.exitCode = 1;
});
