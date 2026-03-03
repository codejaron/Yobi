import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokensFromText,
  parseUsageTokens
} from "../services/token/token-usage-utils.js";

test("parseUsageTokens: should prefer totalTokens", () => {
  const parsed = parseUsageTokens({
    totalTokens: 88,
    inputTokens: 22,
    outputTokens: 33
  });

  assert.equal(parsed.tokens, 88);
  assert.equal(parsed.mode, "provider");
  assert.equal(parsed.estimated, false);
});

test("parseUsageTokens: should support snake_case and numeric strings", () => {
  const parsed = parseUsageTokens({
    prompt_tokens: "25",
    completion_tokens: "31"
  });

  assert.equal(parsed.tokens, 56);
  assert.equal(parsed.mode, "provider");
  assert.equal(parsed.estimated, false);
});

test("parseUsageTokens: should support nested usage payload", () => {
  const parsed = parseUsageTokens({
    usage: {
      total_tokens: 64
    }
  });

  assert.equal(parsed.tokens, 64);
  assert.equal(parsed.mode, "provider");
  assert.equal(parsed.estimated, false);
});

test("parseUsageTokens: should return missing for unknown payload", () => {
  const parsed = parseUsageTokens({ foo: "bar" });

  assert.equal(parsed.tokens, 0);
  assert.equal(parsed.mode, "missing");
  assert.equal(parsed.estimated, false);
});

test("estimateTokensFromText: should estimate from text length", () => {
  assert.equal(estimateTokensFromText("", ""), 0);
  assert.equal(estimateTokensFromText("abcd", ""), 1);
  assert.equal(estimateTokensFromText("abcdefgh", "ijkl"), 3);
});
