import test from "node:test";
import assert from "node:assert/strict";
import {
  CONSOLE_CHAT_AUTO_FOLLOW_THRESHOLD_PX,
  getNextConsoleChatAutoFollowState,
  isConsoleChatNearBottom
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
