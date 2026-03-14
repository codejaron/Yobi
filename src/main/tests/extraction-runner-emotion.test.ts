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
});

test("parseExtractionObject: 附带 emotional_signals 会被忽略", () => {
  const parsed = parseExtractionObject({
    operations: [],
    emotional_signals: {
      emotion_label: "happy",
      intensity: 0.8,
      engagement: 0.85,
      trust_delta: 0.12
    }
  });

  assert.equal(parsed.operations.length, 0);
});

test("parseExtractionObject: 非法 emotional_signals 同样会被忽略", () => {
  const parsed = parseExtractionObject({
    operations: [],
    emotional_signals: {
      emotion_label: "grateful",
      intensity: 1.2,
      engagement: 1.2,
      trust_delta: 0.2
    }
  });

  assert.equal(parsed.operations.length, 0);
});
