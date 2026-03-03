import test from "node:test";
import assert from "node:assert/strict";
import {
  canEventShare,
  isInterestColdStart,
  nextAuthStateFromNav
} from "../services/browse/rules.js";

test("cold-start: less than 3 interest terms should be treated as cold start", () => {
  assert.equal(isInterestColdStart(0), true);
  assert.equal(isInterestColdStart(2), true);
  assert.equal(isInterestColdStart(3), false);
  assert.equal(isInterestColdStart(8), false);
});

test("event share should be blocked when daily cap is reached", () => {
  const allowed = canEventShare({
    todayEventShares: 2,
    eventDailyCap: 2,
    elapsedSinceInteractionMs: 20 * 60 * 1000,
    eventMinGapMs: 15 * 60 * 1000
  });
  assert.equal(allowed, false);
});

test("event share should be blocked when minimum gap is not reached", () => {
  const allowed = canEventShare({
    todayEventShares: 0,
    eventDailyCap: 2,
    elapsedSinceInteractionMs: 8 * 60 * 1000,
    eventMinGapMs: 15 * 60 * 1000
  });
  assert.equal(allowed, false);
});

test("event share should pass when cap and gap constraints are both satisfied", () => {
  const allowed = canEventShare({
    todayEventShares: 1,
    eventDailyCap: 2,
    elapsedSinceInteractionMs: 16 * 60 * 1000,
    eventMinGapMs: 15 * 60 * 1000
  });
  assert.equal(allowed, true);
});

test("auth state should become expired and paused when nav reports logged-out", () => {
  const expired = nextAuthStateFromNav(false);
  assert.equal(expired.authState, "expired");
  assert.ok(expired.pausedReason);

  const active = nextAuthStateFromNav(true);
  assert.equal(active.authState, "active");
  assert.equal(active.pausedReason, null);
});
