import test from "node:test";
import assert from "node:assert/strict";
import { getConsoleComposerKeyAction } from "@shared/console-chat-composer";

test("getConsoleComposerKeyAction: Enter submits when no approval is pending", () => {
  assert.equal(
    getConsoleComposerKeyAction({
      key: "Enter",
      shiftKey: false,
      pendingApproval: false,
      isComposing: false,
      slashMenuOpen: false
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
      isComposing: false,
      slashMenuOpen: false
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
      isComposing: true,
      slashMenuOpen: false
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
      isComposing: false,
      slashMenuOpen: true
    }),
    "approval-up"
  );

  assert.equal(
    getConsoleComposerKeyAction({
      key: "ArrowDown",
      shiftKey: false,
      pendingApproval: true,
      isComposing: false,
      slashMenuOpen: true
    }),
    "approval-down"
  );

  assert.equal(
    getConsoleComposerKeyAction({
      key: "Enter",
      shiftKey: true,
      pendingApproval: true,
      isComposing: false,
      slashMenuOpen: true
    }),
    "approval-confirm"
  );
});

test("getConsoleComposerKeyAction: slash menu shortcuts override submit behavior", () => {
  assert.equal(
    getConsoleComposerKeyAction({
      key: "ArrowUp",
      shiftKey: false,
      pendingApproval: false,
      isComposing: false,
      slashMenuOpen: true
    }),
    "slash-up"
  );

  assert.equal(
    getConsoleComposerKeyAction({
      key: "ArrowDown",
      shiftKey: false,
      pendingApproval: false,
      isComposing: false,
      slashMenuOpen: true
    }),
    "slash-down"
  );

  assert.equal(
    getConsoleComposerKeyAction({
      key: "Enter",
      shiftKey: false,
      pendingApproval: false,
      isComposing: false,
      slashMenuOpen: true
    }),
    "slash-confirm"
  );

  assert.equal(
    getConsoleComposerKeyAction({
      key: "Escape",
      shiftKey: false,
      pendingApproval: false,
      isComposing: false,
      slashMenuOpen: true
    }),
    "slash-close"
  );
});
