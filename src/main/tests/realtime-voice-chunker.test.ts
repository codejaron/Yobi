import test from "node:test";
import assert from "node:assert/strict";
import { SentenceChunkBuffer } from "../services/realtime-voice-chunker.js";

test("SentenceChunkBuffer: first chunk flushes aggressively on sentence punctuation", () => {
  const buffer = new SentenceChunkBuffer({
    firstChunkMinChars: 2,
    subsequentChunkMinChars: 8
  });

  const emitted = buffer.push("你好。今天我们继续聊");

  assert.deepEqual(emitted, ["你好。"]);
  assert.equal(buffer.getPendingText(), "今天我们继续聊");
});

test("SentenceChunkBuffer: strips hidden tags before emitting TTS chunks", () => {
  const buffer = new SentenceChunkBuffer({
    firstChunkMinChars: 2,
    subsequentChunkMinChars: 4
  });

  const emitted = buffer.push(
    "<think>internal</think>你好。<signals emotion_label=\"neutral\" intensity=\"0.5\" engagement=\"0.5\" trust_delta=\"0\" />"
  );

  assert.deepEqual(emitted, ["你好。"]);
  assert.equal(buffer.getPendingText(), "");
});

test("SentenceChunkBuffer: later chunks wait for longer threshold before comma split", () => {
  const buffer = new SentenceChunkBuffer({
    firstChunkMinChars: 2,
    subsequentChunkMinChars: 8
  });

  assert.deepEqual(buffer.push("你好。"), ["你好。"]);
  assert.deepEqual(buffer.push("我想和你说，"), []);
  assert.deepEqual(buffer.push("现在先别着急。"), ["我想和你说，现在先别着急。"]);
});

test("SentenceChunkBuffer: flush emits remaining visible text only", () => {
  const buffer = new SentenceChunkBuffer({
    firstChunkMinChars: 2,
    subsequentChunkMinChars: 8
  });

  buffer.push("先说一点");
  const flushed = buffer.flush();

  assert.deepEqual(flushed, ["先说一点"]);
  assert.equal(buffer.getPendingText(), "");
});
