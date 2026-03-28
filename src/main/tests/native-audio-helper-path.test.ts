import test from "node:test";
import assert from "node:assert/strict";
import {
  executableName,
  platformKey,
  resolveNativeAudioHelperPathFrom
} from "@main/services/native-audio-helper-path";

test("native audio helper path: returns env override first", () => {
  const actual = resolveNativeAudioHelperPathFrom({
    platform: "darwin",
    arch: "arm64",
    envOverride: "/tmp/custom-native-audio-helper",
    resourcesPath: "/Applications/Yobi.app/Contents/Resources",
    appPath: "/Applications/Yobi.app/Contents/Resources/app.asar",
    helperExists: () => false
  });

  assert.equal(actual, "/tmp/custom-native-audio-helper");
});

test("native audio helper path: prefers packaged resource path when present", () => {
  const actual = resolveNativeAudioHelperPathFrom({
    platform: "win32",
    arch: "x64",
    envOverride: "",
    resourcesPath: "C:\\Program Files\\Yobi\\resources",
    appPath: "C:\\Program Files\\Yobi\\resources\\app.asar",
    helperExists: (candidate) =>
      candidate === "C:\\Program Files\\Yobi\\resources\\native-audio\\bin\\win32-x64\\yobi-native-audio.exe"
  });

  assert.equal(
    actual,
    "C:\\Program Files\\Yobi\\resources\\native-audio\\bin\\win32-x64\\yobi-native-audio.exe"
  );
});

test("native audio helper path: falls back to project resources during development", () => {
  const actual = resolveNativeAudioHelperPathFrom({
    platform: "darwin",
    arch: "x64",
    envOverride: "",
    resourcesPath: "/Applications/Yobi.app/Contents/Resources",
    appPath: "/Users/jaron/data/project/Yobi",
    helperExists: () => false
  });

  assert.equal(
    actual,
    "/Users/jaron/data/project/Yobi/resources/native-audio/bin/darwin-x64/yobi-native-audio"
  );
});

test("native audio helper path: derives platform-specific names", () => {
  assert.equal(platformKey("darwin", "arm64"), "darwin-arm64");
  assert.equal(platformKey("win32", "x64"), "win32-x64");
  assert.equal(executableName("darwin"), "yobi-native-audio");
  assert.equal(executableName("win32"), "yobi-native-audio.exe");
});
