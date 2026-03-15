import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

test("test script uses cross-platform cleanup", () => {
  const root = process.cwd();
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };

  const testScript = pkg.scripts?.test ?? "";
  assert.match(testScript, /\bnode\s+\.\/scripts\/clean-test-output\.mjs\b/);
  assert.match(testScript, /\bnode\s+\.\/scripts\/run-node-tests\.mjs\b/);
  assert.doesNotMatch(testScript, /\brm\s+-rf\b/);
  assert.doesNotMatch(testScript, /out\/src\/main\/tests\/\*\.test\.js/);
});
