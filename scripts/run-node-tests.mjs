import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const testsDir = path.join(process.cwd(), "out", "src", "main", "tests");

function listTestFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTestFiles(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".test.js")) {
      files.push(entryPath);
    }
  }

  return files.sort();
}

const testFiles = listTestFiles(testsDir);
if (testFiles.length === 0) {
  throw new Error(`No compiled tests found under ${testsDir}`);
}

const result = spawnSync(
  process.execPath,
  [
    "--experimental-specifier-resolution=node",
    "--loader",
    "./scripts/alias-loader.mjs",
    "--test",
    ...testFiles
  ],
  {
    stdio: "inherit"
  }
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
