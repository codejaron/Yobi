import test from "node:test";
import assert from "node:assert/strict";
import * as inboundMedia from "../channels/inbound-media.js";

test("resolveInboundImageText returns empty text when there is no caption", () => {
  const result = (inboundMedia as any).resolveInboundImageText({
    text: ""
  });

  assert.equal(result, "");
});

test("resolveInboundImageText trims image caption text", () => {
  const result = (inboundMedia as any).resolveInboundImageText({
    text: "  看看这张图  "
  });

  assert.equal(result, "看看这张图");
});
