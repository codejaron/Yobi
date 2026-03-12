import test from "node:test";
import assert from "node:assert/strict";
import { ConsoleChannel } from "../channels/console.js";

test("ConsoleChannel: abortPendingApprovalsByRequest resolves approval as aborted without emitting decision", async () => {
  const channel = new ConsoleChannel();
  const events: string[] = [];

  const unsubscribe = channel.onEvent((event) => {
    events.push(event.type);
  });

  const approvalPromise = channel.makeApprovalHandler("request-1")({
    toolName: "system",
    params: { command: "say hi" },
    description: "run command",
    signature: "system:say hi"
  });

  assert.deepEqual(events, ["approval-request"]);

  const aborted = channel.abortPendingApprovalsByRequest("request-1");
  const result = await approvalPromise;

  unsubscribe();

  assert.equal(aborted, 1);
  assert.deepEqual(result, { kind: "aborted" });
  assert.deepEqual(events, ["approval-request"]);
  assert.deepEqual(
    channel.resolveApproval({
      approvalId: "missing",
      decision: "allow-once"
    }),
    { accepted: false }
  );
});
