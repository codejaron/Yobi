import test from "node:test";
import assert from "node:assert/strict";
import { isDarkTheme, resolveTheme, THEME_MODE_STORAGE_KEY } from "@shared/theme";

test("theme: resolves explicit light and dark modes", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});

test("theme: follows system preference when mode is system", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(isDarkTheme("system", true), true);
  assert.equal(isDarkTheme("system", false), false);
});

test("theme: exposes stable storage key", () => {
  assert.equal(THEME_MODE_STORAGE_KEY, "yobi.theme-mode");
});
