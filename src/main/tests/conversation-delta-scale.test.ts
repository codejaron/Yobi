import test from "node:test";
import assert from "node:assert/strict";
import { computeMessageCadenceScale } from "../kernel/engine.js";

test("computeMessageCadenceScale: 首条消息使用完整增幅", () => {
  assert.equal(computeMessageCadenceScale(null), 1);
});

test("computeMessageCadenceScale: 高频连发降到最小缩放", () => {
  assert.equal(computeMessageCadenceScale(30_000), 0.3);
  assert.equal(computeMessageCadenceScale(2 * 60_000), 0.3);
});

test("computeMessageCadenceScale: 长间隔回到完整增幅", () => {
  assert.equal(computeMessageCadenceScale(10 * 60_000), 1);
  assert.equal(computeMessageCadenceScale(20 * 60_000), 1);
});

test("computeMessageCadenceScale: 中间区间线性插值", () => {
  const scale = computeMessageCadenceScale(6 * 60_000);
  assert.ok(scale > 0.3);
  assert.ok(scale < 1);
});
