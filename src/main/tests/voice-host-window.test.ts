import test from "node:test";
import assert from "node:assert/strict";
import {
  VoiceHostWindowController,
  cleanupClosedVoiceHostWindowState
} from "../services/voice-host-window.js";

function createLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  } as const;
}

test("voice host window: host-ready from a pending window resolves readiness", () => {
  const controller = new VoiceHostWindowController(createLogger() as never) as any;
  let readyResolved = false;

  controller.pendingWindow = {
    isDestroyed: () => false,
    webContents: {
      id: 99
    }
  };
  controller.resolveReady = () => {
    readyResolved = true;
  };

  controller.handleIpcEvent(
    {
      sender: {
        id: 99
      }
    },
    {
      type: "host-ready"
    }
  );

  assert.equal(readyResolved, true);
  assert.equal(controller.resolveReady, null);
});

test("voice host window: closed cleanup does not touch destroyed webContents", () => {
  const closedWindow = {
    get webContents() {
      throw new Error("webContents should not be accessed after close");
    }
  };
  const otherWindow = {};

  const result = cleanupClosedVoiceHostWindowState({
    window: closedWindow,
    pendingWindow: otherWindow,
    readyWindowId: 99,
    closedWindow,
    closedWindowId: 99
  });

  assert.equal(result.window, null);
  assert.equal(result.pendingWindow, otherWindow);
  assert.equal(result.readyWindowId, null);
});
