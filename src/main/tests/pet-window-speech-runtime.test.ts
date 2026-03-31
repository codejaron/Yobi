import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

test("pet window: local speech uses advanced model.speak instead of legacy audio lipsync", () => {
  const root = process.cwd();
  const html = readFileSync(path.join(root, "resources", "pet-window.html"), "utf8");

  assert.match(html, /model\.speak\(/);
  assert.match(html, /model\.stopSpeaking\(/);
  assert.doesNotMatch(html, /startAudioLipSync\(audio\)/);
  assert.match(html, /sampleModelLipSyncOpen/);
  assert.match(html, /emotionRenderer\.setLipSyncOpen\(sampleModelLipSyncOpen\(\)\)/);
});
