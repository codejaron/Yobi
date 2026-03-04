import test from "node:test";
import assert from "node:assert/strict";
import {
  reportTokenUsage,
  setTokenRecorder,
  type TokenUsageReportEvent
} from "../services/token/token-usage-reporter.js";

function waitForAsyncQueue(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

test("token-usage-reporter: should no-op when recorder is not configured", async () => {
  setTokenRecorder(null);

  reportTokenUsage({
    source: "chat:console",
    usage: {
      totalTokens: 12
    }
  });

  await waitForAsyncQueue();
  assert.ok(true);
});

test("token-usage-reporter: should forward event to recorder", async () => {
  const events: TokenUsageReportEvent[] = [];
  setTokenRecorder((event) => {
    events.push(event);
  });

  reportTokenUsage({
    source: "background:fact-extraction",
    inputText: "input",
    outputText: "output"
  });

  await waitForAsyncQueue();
  setTokenRecorder(null);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.source, "background:fact-extraction");
  assert.equal(events[0]?.inputText, "input");
});

test("token-usage-reporter: should swallow recorder errors", async () => {
  let called = false;
  setTokenRecorder(() => {
    called = true;
    throw new Error("boom");
  });

  reportTokenUsage({
    source: "chat:qq",
    outputText: "reply"
  });

  await waitForAsyncQueue();
  setTokenRecorder(null);

  assert.equal(called, true);
});
