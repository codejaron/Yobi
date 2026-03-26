import test from "node:test";
import assert from "node:assert/strict";
import {
  executableName,
  platformKey,
  resolveMacCaptureHelperPathFrom
} from "@main/services/macos-capture-helper-path";

test("mac capture helper path: returns env override first", () => {
  const actual = resolveMacCaptureHelperPathFrom({
    platform: "darwin",
    arch: "arm64",
    envOverride: "/tmp/custom-helper",
    resourcesPath: "/Applications/Yobi.app/Contents/Resources",
    appPath: "/Applications/Yobi.app/Contents/Resources/app.asar",
    helperExists: () => false
  });

  assert.equal(actual, "/tmp/custom-helper");
});

test("mac capture helper path: prefers packaged resource path when present", () => {
  const actual = resolveMacCaptureHelperPathFrom({
    platform: "darwin",
    arch: "arm64",
    envOverride: "",
    resourcesPath: "/Applications/Yobi.app/Contents/Resources",
    appPath: "/Applications/Yobi.app/Contents/Resources/app.asar",
    helperExists: (candidate) =>
      candidate ===
      "/Applications/Yobi.app/Contents/Resources/mac-screen-capture/bin/darwin-arm64/yobi-mac-screen-capture",
  });

  assert.equal(
    actual,
    "/Applications/Yobi.app/Contents/Resources/mac-screen-capture/bin/darwin-arm64/yobi-mac-screen-capture"
  );
});

test("mac capture helper path: falls back to project resources during development", () => {
  const actual = resolveMacCaptureHelperPathFrom({
    platform: "darwin",
    arch: "x64",
    envOverride: "",
    resourcesPath: "/Applications/Yobi.app/Contents/Resources",
    appPath: "/Users/jaron/data/project/Yobi",
    helperExists: () => false
  });

  assert.equal(
    actual,
    "/Users/jaron/data/project/Yobi/resources/mac-screen-capture/bin/darwin-x64/yobi-mac-screen-capture"
  );
});

test("mac capture helper path: derives platform-specific names", () => {
  assert.equal(platformKey("darwin", "arm64"), "darwin-arm64");
  assert.equal(executableName("darwin"), "yobi-mac-screen-capture");
});
