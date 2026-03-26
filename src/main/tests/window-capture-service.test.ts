import test from "node:test";
import assert from "node:assert/strict";
import {
  captureWindowImage,
  shouldUseMacCaptureHelper,
  type WindowCaptureInput,
  type WindowCaptureResult
} from "@main/services/window-capture-service";

function createResult(label: string): WindowCaptureResult {
  return {
    pngBuffer: Buffer.from(label),
    appName: `${label}-app`,
    title: `${label}-title`,
    focused: label === "mac"
  };
}

function createInput(): WindowCaptureInput {
  return {
    appName: "Safari"
  };
}

test("window capture service: uses mac helper on darwin", async () => {
  let macCalls = 0;
  let nodeCalls = 0;

  const result = await captureWindowImage(createInput(), {
    platform: "darwin",
    captureWithMacHelper: async () => {
      macCalls += 1;
      return createResult("mac");
    },
    captureWithNodeScreenshots: async () => {
      nodeCalls += 1;
      return createResult("node");
    }
  });

  assert.equal(macCalls, 1);
  assert.equal(nodeCalls, 0);
  assert.equal(result?.appName, "mac-app");
});

test("window capture service: uses node-screenshots on win32", async () => {
  let macCalls = 0;
  let nodeCalls = 0;

  const result = await captureWindowImage(createInput(), {
    platform: "win32",
    captureWithMacHelper: async () => {
      macCalls += 1;
      return createResult("mac");
    },
    captureWithNodeScreenshots: async () => {
      nodeCalls += 1;
      return createResult("node");
    }
  });

  assert.equal(macCalls, 0);
  assert.equal(nodeCalls, 1);
  assert.equal(result?.appName, "node-app");
});

test("window capture service: helper routing is mac-only", () => {
  assert.equal(shouldUseMacCaptureHelper("darwin"), true);
  assert.equal(shouldUseMacCaptureHelper("win32"), false);
  assert.equal(shouldUseMacCaptureHelper("linux"), false);
});
