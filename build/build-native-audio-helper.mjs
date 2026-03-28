import path from "node:path";
import { spawn } from "node:child_process";
import { chmod, cp, mkdir } from "node:fs/promises";

function executableName() {
  return process.platform === "win32" ? "yobi-native-audio.exe" : "yobi-native-audio";
}

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
      ...options
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
  if (process.platform !== "darwin" && process.platform !== "win32") {
    console.log("[native-audio-helper] skipped on unsupported host");
    return;
  }

  const projectRoot = process.cwd();
  const manifestPath = path.join(projectRoot, "native", "audio-helper", "Cargo.toml");
  const crateRoot = path.dirname(manifestPath);
  const outputDir = path.join(projectRoot, "resources", "native-audio", "bin", platformKey());
  const outputPath = path.join(outputDir, executableName());
  const cargoTargetPath = path.join(crateRoot, "target", "release", executableName());

  await runCommand("cargo", [
    "build",
    "--release",
    "--manifest-path",
    manifestPath
  ]);

  await mkdir(outputDir, { recursive: true });
  await cp(cargoTargetPath, outputPath, { force: true });
  if (process.platform !== "win32") {
    await chmod(outputPath, 0o755);
  }
  console.log(`[native-audio-helper] built ${outputPath}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[native-audio-helper] failed: ${message}`);
  process.exitCode = 1;
});
