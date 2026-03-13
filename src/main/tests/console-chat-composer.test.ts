import test from "node:test";
import assert from "node:assert/strict";
import { getConsoleComposerKeyAction } from "@shared/console-chat-composer";

test("getConsoleComposerKeyAction: Enter submits when no approval is pending", () => {
  assert.equal(
    getConsoleComposerKeyAction({
      key: "Enter",
      shiftKey: false,
      pendingApproval: false,
      isComposing: false
    }),
    "submit"
  );
});

test("getConsoleComposerKeyAction: Shift+Enter keeps newline behavior", () => {
  assert.equal(
    getConsoleComposerKeyAction({
      key: "Enter",
      shiftKey: true,
      pendingApproval: false,
      isComposing: false
    }),
    "none"
  );
});

test("getConsoleComposerKeyAction: composing text should not submit on Enter", () => {
  assert.equal(
    getConsoleComposerKeyAction({
      key: "Enter",
      shiftKey: false,
      pendingApproval: false,
      isComposing: true
    }),
    "none"
  );
});

test("getConsoleComposerKeyAction: approval shortcuts override normal composer behavior", () => {
  assert.equal(
    getConsoleComposerKeyAction({
      key: "ArrowUp",
      shiftKey: false,
      pendingApproval: true,
      isComposing: false
    }),
    "approval-up"
  );

  assert.equal(
    getConsoleComposerKeyAction({
      key: "ArrowDown",
      shiftKey: false,
      pendingApproval: true,
      isComposing: false
    }),
    "approval-down"
  );

  assert.equal(
    getConsoleComposerKeyAction({
      key: "Enter",
      shiftKey: true,
      pendingApproval: true,
      isComposing: false
    }),
    "approval-confirm"
  );
});
