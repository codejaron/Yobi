import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

test("pet window: speech runtime queues model.speak playback without manual lipsync bridge", () => {
  const root = process.cwd();
  const html = readFileSync(path.join(root, "resources", "pet-window.html"), "utf8");

  assert.match(html, /model\.speak\(/);
  assert.match(html, /model\.stopSpeaking\(/);
  assert.match(html, /new Blob\(/);
  assert.match(html, /URL\.createObjectURL\(/);
  assert.match(html, /URL\.revokeObjectURL\(/);
  assert.match(html, /installPixiSoundCompat/);
  assert.match(html, /PIXI\.Sound = pixiSound\.Sound/);
  assert.match(html, /PIXI\.webaudio = pixiSound\.webaudio/);
  assert.match(html, /disableAutoPause = true/);
  assert.match(html, /audioContext\.resume\(\)/);
  assert.match(html, /voice:talking-motion-skip-primary-fallback/);
  assert.match(html, /speech-enqueue/);
  assert.match(html, /speech-clear/);
  assert.doesNotMatch(html, /startPrimaryTalkingMotion/);
  assert.doesNotMatch(html, /playPrimaryMotionLastFrame/);
  assert.doesNotMatch(html, /sampleModelLipSyncOpen/);
  assert.doesNotMatch(html, /setLipSyncOpen/);
  assert.doesNotMatch(html, /speech-level/);
});
