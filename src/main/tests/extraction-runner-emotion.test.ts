import test from "node:test";
import assert from "node:assert/strict";
import { parseExtractionObject } from "../memory-v2/extraction-runner.js";

test("parseExtractionObject: 仅 operations 也可解析", () => {
  const parsed = parseExtractionObject({
    operations: [
      {
        action: "add",
        fact: {
          entity: "用户",
          key: "兴趣",
          value: "摄影"
        }
      }
    ]
  });

  assert.equal(parsed.operations.length, 1);
  assert.equal(parsed.operations[0]?.fact.entity, "用户");
  assert.equal(parsed.emotionalSignals, undefined);
});

test("parseExtractionObject: operations + emotional_signals 一起解析", () => {
  const parsed = parseExtractionObject({
    operations: [],
    emotional_signals: {
      user_mood: "positive",
      engagement: 0.85,
      trust_delta: 0.12,
      friction: false,
      curiosity_trigger: true
    }
  });

  assert.equal(parsed.operations.length, 0);
  assert.ok(parsed.emotionalSignals);
  assert.equal(parsed.emotionalSignals?.user_mood, "positive");
  assert.equal(parsed.emotionalSignals?.engagement, 0.85);
  assert.equal(parsed.emotionalSignals?.curiosity_trigger, true);
});

test("parseExtractionObject: 非法 emotional_signals 会被忽略", () => {
  const parsed = parseExtractionObject({
    operations: [],
    emotional_signals: {
      user_mood: "positive",
      engagement: 1.2,
      trust_delta: 0.2,
      friction: false,
      curiosity_trigger: true
    }
  });

  assert.equal(parsed.operations.length, 0);
  assert.equal(parsed.emotionalSignals, undefined);
});
