import test from "node:test";
import assert from "node:assert/strict";
import { applyScaledDeltaToState } from "../core/conversation.js";
import type { EmotionalState } from "@shared/types";

const base: EmotionalState = {
  mood: 0,
  energy: 0.6,
  connection: 0.5,
  curiosity: 0.5,
  confidence: 0.5,
  irritation: 0.1
};

test("applyScaledDeltaToState: deltaScale 会按比例缩小即时 delta", () => {
  const full = applyScaledDeltaToState({
    emotional: base,
    delta: {
      mood: 0.2,
      connection: 0.1
    },
    scale: 1
  });

  const scaled = applyScaledDeltaToState({
    emotional: base,
    delta: {
      mood: 0.2,
      connection: 0.1
    },
    scale: 0.4
  });

  assert.equal(full.mood, 0.2);
  assert.equal(scaled.mood, 0.08);
  assert.equal(full.connection, 0.6);
  assert.equal(scaled.connection, 0.54);
});
