import test from "node:test";
import assert from "node:assert/strict";
import {
  CONSOLE_CHAT_AUTO_FOLLOW_THRESHOLD_PX,
  CONSOLE_CHAT_LOAD_OLDER_THRESHOLD_PX,
  getPrependedConsoleChatScrollTop,
  getNextConsoleChatAutoFollowState,
  isConsoleChatNearBottom,
  shouldAutoLoadOlderConsoleChatHistory,
  shouldLoadOlderConsoleChatHistory
} from "@shared/console-chat-scroll";

test("console chat scroll: stays in follow mode near the bottom threshold", () => {
  assert.equal(
    isConsoleChatNearBottom({
      scrollTop: 1_020,
      clientHeight: 500,
      scrollHeight: 1_600
    }),
    true
  );
  assert.equal(CONSOLE_CHAT_AUTO_FOLLOW_THRESHOLD_PX, 80);
});

test("console chat scroll: scrolling away from the bottom disables follow mode", () => {
  assert.equal(
    getNextConsoleChatAutoFollowState({
      type: "user-scroll",
      metrics: {
        scrollTop: 980,
        clientHeight: 500,
        scrollHeight: 1_600
      }
    }),
    false
  );
});

test("console chat scroll: returning to bottom or starting a new turn re-enables follow mode", () => {
  assert.equal(
    getNextConsoleChatAutoFollowState({
      type: "user-scroll",
      metrics: {
        scrollTop: 1_025,
        clientHeight: 500,
        scrollHeight: 1_600
      }
    }),
    true
  );
  assert.equal(
    getNextConsoleChatAutoFollowState({
      type: "history-loaded"
    }),
    true
  );
  assert.equal(
    getNextConsoleChatAutoFollowState({
      type: "submit-message"
    }),
    true
  );
});

test("console chat scroll: loading older history triggers near the top threshold", () => {
  assert.equal(CONSOLE_CHAT_LOAD_OLDER_THRESHOLD_PX, 120);
  assert.equal(
    shouldLoadOlderConsoleChatHistory({
      historyLoaded: true,
      hasMore: true,
      loadingOlder: false,
      metrics: {
        scrollTop: 96,
        clientHeight: 640,
        scrollHeight: 2_000
      }
    }),
    true
  );
});

test("console chat scroll: loading older history is suppressed when unavailable or already pending", () => {
  assert.equal(
    shouldLoadOlderConsoleChatHistory({
      historyLoaded: false,
      hasMore: true,
      loadingOlder: false,
      metrics: {
        scrollTop: 40,
        clientHeight: 640,
        scrollHeight: 2_000
      }
    }),
    false
  );
  assert.equal(
    shouldLoadOlderConsoleChatHistory({
      historyLoaded: true,
      hasMore: false,
      loadingOlder: false,
      metrics: {
        scrollTop: 40,
        clientHeight: 640,
        scrollHeight: 2_000
      }
    }),
    false
  );
  assert.equal(
    shouldLoadOlderConsoleChatHistory({
      historyLoaded: true,
      hasMore: true,
      loadingOlder: true,
      metrics: {
        scrollTop: 40,
        clientHeight: 640,
        scrollHeight: 2_000
      }
    }),
    false
  );
});

test("console chat scroll: prepend scroll restoration keeps the visible anchor stable", () => {
  assert.equal(
    getPrependedConsoleChatScrollTop({
      previousScrollTop: 280,
      previousScrollHeight: 1_800,
      nextScrollHeight: 2_260
    }),
    740
  );
});

test("console chat scroll: auto-fill older history when the viewport is not scrollable yet", () => {
  assert.equal(
    shouldAutoLoadOlderConsoleChatHistory({
      historyLoaded: true,
      hasMore: true,
      loadingOlder: false,
      metrics: {
        scrollTop: 0,
        clientHeight: 720,
        scrollHeight: 680
      }
    }),
    true
  );
  assert.equal(
    shouldAutoLoadOlderConsoleChatHistory({
      historyLoaded: true,
      hasMore: true,
      loadingOlder: false,
      metrics: {
        scrollTop: 0,
        clientHeight: 720,
        scrollHeight: 900
      }
    }),
    false
  );
});
