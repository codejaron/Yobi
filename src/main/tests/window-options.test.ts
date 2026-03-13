import test from "node:test";
import assert from "node:assert/strict";
import { getMainWindowOptions } from "@main/window-options";

test("window options: enables hidden inset title bar on macOS", () => {
  const options = getMainWindowOptions("darwin");

  assert.equal(options.titleBarStyle, "hiddenInset");
  assert.equal(options.backgroundColor, "#f5efe7");
  assert.equal(options.title, "Yobi Companion");
});

test("window options: keeps default framed title bar on non-macOS", () => {
  const options = getMainWindowOptions("win32");

  assert.equal(options.titleBarStyle, undefined);
  assert.equal(options.backgroundColor, "#f5efe7");
  assert.equal(options.title, "Yobi Companion");
});
