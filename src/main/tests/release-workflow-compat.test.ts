import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

test("release workflow uses Node 22 for node:sqlite tests", () => {
  const workflow = readFileSync(path.join(process.cwd(), ".github", "workflows", "release.yml"), "utf8");

  assert.match(workflow, /node-version:\s*22\b/);
});
