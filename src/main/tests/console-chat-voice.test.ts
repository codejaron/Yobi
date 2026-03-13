import test from "node:test";
import assert from "node:assert/strict";
import { shouldDisableConsoleMicButton } from "@shared/console-chat-voice";

test("shouldDisableConsoleMicButton: idle mic stays clickable without pre-check gating", () => {
  assert.equal(
    shouldDisableConsoleMicButton({
      pendingApproval: false,
      recording: false,
      transcribing: false,
      busy: false
    }),
    false
  );
});

test("shouldDisableConsoleMicButton: approval blocks mic unless already recording", () => {
  assert.equal(
    shouldDisableConsoleMicButton({
      pendingApproval: true,
      recording: false,
      transcribing: false,
      busy: false
    }),
    true
  );

  assert.equal(
    shouldDisableConsoleMicButton({
      pendingApproval: true,
      recording: true,
      transcribing: false,
      busy: false
    }),
    false
  );
});

test("shouldDisableConsoleMicButton: busy and transcribing states still block mic", () => {
  assert.equal(
    shouldDisableConsoleMicButton({
      pendingApproval: false,
      recording: false,
      transcribing: true,
      busy: false
    }),
    true
  );

  assert.equal(
    shouldDisableConsoleMicButton({
      pendingApproval: false,
      recording: false,
      transcribing: false,
      busy: true
    }),
    true
  );
});
