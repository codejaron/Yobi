import path from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const runtimeDir = path.join(projectRoot, "resources", "openclaw-runtime");
const packageSpec = process.env.OPENCLAW_PACKAGE?.trim() || "";

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: "inherit"
    });

    child.once("error", (error) => {
      reject(error);
    });

    child.once("exit", (code) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }
      reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function main() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const binName = process.platform === "win32" ? "openclaw.cmd" : "openclaw";
  const existingBinPath = path.join(runtimeDir, "node_modules", ".bin", binName);

  await mkdir(runtimeDir, {
    recursive: true
  });

  if (!packageSpec && existsSync(existingBinPath)) {
    console.log(`[openclaw] reusing existing bundled runtime at ${runtimeDir}`);
    return;
  }

  await rm(path.join(runtimeDir, "node_modules"), {
    recursive: true,
    force: true
  });
  const runtimePackagePath = path.join(runtimeDir, "package.json");
  let runtimePackageJson = {
    name: "yobi-openclaw-runtime",
    private: true,
    version: "0.0.0",
    description: "Bundled OpenClaw runtime for Yobi",
    dependencies: {
      openclaw: "2026.3.2"
    }
  };

  try {
    const existing = JSON.parse(await readFile(runtimePackagePath, "utf8"));
    if (existing && typeof existing === "object") {
      runtimePackageJson = {
        ...runtimePackageJson,
        ...existing
      };
    }
  } catch {}

  if (packageSpec) {
    runtimePackageJson.dependencies = {
      ...(runtimePackageJson.dependencies || {}),
      openclaw: packageSpec.replace(/^openclaw@/, "")
    };
  }

  await writeFile(runtimePackagePath, `${JSON.stringify(runtimePackageJson, null, 2)}\n`, "utf8");

  const hasLockfile = existsSync(path.join(runtimeDir, "package-lock.json"));
  await run(
    npmCommand,
    hasLockfile
      ? ["ci", "--omit=dev", "--no-audit", "--no-fund"]
      : ["install", "--omit=dev", "--no-audit", "--no-fund"],
    runtimeDir
  );

  const binPath = path.join(runtimeDir, "node_modules", ".bin", binName);

  if (!existsSync(binPath)) {
    throw new Error(`OpenClaw binary not found after install: ${binPath}`);
  }

  console.log(`[openclaw] bundled runtime prepared at ${runtimeDir}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[openclaw] prebuild failed: ${message}`);
  process.exitCode = 1;
});
