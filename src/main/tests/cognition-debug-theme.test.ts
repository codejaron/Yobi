import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const cognitionDebugPath = path.join(process.cwd(), "src", "renderer", "pages", "CognitionDebug.tsx");

test("CognitionDebug: avoids hard-coded light-only utility tokens", async () => {
  const source = await readFile(cognitionDebugPath, "utf8");
  const bannedPatterns = [
    /text-slate-(?:50|100|200|300|400|500|600|700|800|900)/,
    /bg-slate-(?:50|100|200|300|400|500|600|700|800|900)/,
    /bg-white(?:\/\d+)?/
  ];

  for (const pattern of bannedPatterns) {
    assert.equal(
      pattern.test(source),
      false,
      `Expected ${cognitionDebugPath} to avoid light-theme-only utility token: ${pattern.source}`
    );
  }
});
