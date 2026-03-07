import test from "node:test";
import assert from "node:assert/strict";
import { createEmotionTagStripper, extractEmotionTag, stripEmotionTags } from "../core/emotion-tags.js";

test("extractEmotionTag: 可解析合法 signals 并清理隐藏标签", () => {
  const parsed = extractEmotionTag(
    '今天有点累<signals user_mood="negative" engagement="0.2" trust_delta="-0.1" friction="true" curiosity_trigger="false" /><e:sad/>'
  );

  assert.equal(parsed.cleanedText, "今天有点累");
  assert.equal(parsed.emotion, "sad");
  assert.deepEqual(parsed.signals, {
    user_mood: "negative",
    engagement: 0.2,
    trust_delta: -0.1,
    friction: true,
    curiosity_trigger: false
  });
});

test("extractEmotionTag: 非法 signals 会被忽略且不污染可见文本", () => {
  const parsed = extractEmotionTag(
    'hello<signals user_mood="positive" engagement="1.2" trust_delta="0" friction="false" curiosity_trigger="false" />'
  );

  assert.equal(parsed.cleanedText, "hello");
  assert.equal(parsed.signals, null);
});

test("extractEmotionTag: 字段缺失时 signals 解析失败", () => {
  const parsed = extractEmotionTag('ok<signals user_mood="neutral" engagement="0.5" trust_delta="0" friction="false" />');

  assert.equal(parsed.cleanedText, "ok");
  assert.equal(parsed.signals, null);
});

test("stripEmotionTags: 半截 signals 标签不会泄漏", () => {
  const cleaned = stripEmotionTags("ping<signals user_mood=\"neutral\"");
  assert.equal(cleaned, "ping");
});

test("createEmotionTagStripper: 流式半截标签不会输出到前端", () => {
  const stripper = createEmotionTagStripper();

  const part1 = stripper.push("你好<signals user_mood=\"neutral\"");
  const part2 = stripper.push(" engagement=\"0.5\" trust_delta=\"0\" friction=\"false\" curiosity_trigger=\"false\" />");
  const tail = stripper.flush();

  assert.equal(part1, "你好");
  assert.equal(part2, "");
  assert.equal(tail, "");
});
