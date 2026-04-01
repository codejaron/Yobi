import test from "node:test";
import assert from "node:assert/strict";
import { isAbortLikeError } from "../core/conversation-abort.js";

test("conversation abort: undici terminated errors are treated as abort-like", () => {
  assert.equal(isAbortLikeError(new TypeError("terminated")), true);
  assert.equal(isAbortLikeError(new Error(" Terminated ")), true);
  assert.equal(isAbortLikeError(new Error("socket hang up")), false);
});
