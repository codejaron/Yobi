import test from "node:test";
import assert from "node:assert/strict";
import { extractQueryTerms, matchFacts } from "../memory-v2/retrieval.js";
import type { Fact } from "@shared/types";

const baseFact: Fact = {
  id: "fact-1",
  entity: "用户",
  key: "喜欢的游戏",
  value: "原神",
  category: "preference",
  confidence: 0.8,
  source: "test",
  created_at: "2026-03-01T00:00:00.000Z",
  updated_at: "2026-03-05T00:00:00.000Z",
  ttl_class: "stable",
  last_accessed_at: "2026-03-05T00:00:00.000Z",
  superseded_by: null
};

test("extractQueryTerms: 中文无空格输入也能产出 n-gram", () => {
  const terms = extractQueryTerms(["我最近一直在玩原神"]).map((item) => item.value);
  assert.ok(terms.includes("原神"));
});

test("matchFacts: 中文字面子串可命中 fact", () => {
  const terms = extractQueryTerms(["原神真好玩"]);
  const matched = matchFacts([baseFact], terms, 5);
  assert.equal(matched.length, 1);
  assert.equal(matched[0]?.fact.id, baseFact.id);
});
