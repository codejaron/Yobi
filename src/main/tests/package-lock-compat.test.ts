import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

test("package-lock has no versionless package entries that break npm 10 ci", () => {
  const root = process.cwd();
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8")) as {
    packages?: Record<string, { version?: string }>;
  };

  const versionlessEntries = Object.entries(lock.packages ?? {})
    .filter(([pkgPath, meta]) => pkgPath !== "" && !pkgPath.endsWith("node_modules/.bin") && !meta.version)
    .map(([pkgPath]) => pkgPath);

  assert.deepEqual(versionlessEntries, []);
});
