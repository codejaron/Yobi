import test from "node:test";
import assert from "node:assert/strict";
import { buildConsoleChatRequestPayload } from "@shared/console-chat-request";

test("buildConsoleChatRequestPayload: carries attachments, voice context, and task mode", () => {
  const payload = buildConsoleChatRequestPayload({
    text: "修一下这个问题",
    attachments: [
      {
        name: "trace.txt",
        mimeType: "text/plain",
        size: 12,
        dataBase64: "dGVzdA=="
      }
    ],
    voiceContext: {
      provider: "sensevoice-local",
      metadata: {
        language: "zh",
        emotion: "calm",
        event: "speech",
        rawTags: ["zh", "calm"]
      }
    },
    taskMode: true
  });

  assert.equal(payload.text, "修一下这个问题");
  assert.equal(payload.taskMode, true);
  assert.equal(payload.attachments?.length, 1);
  assert.equal(payload.voiceContext?.provider, "sensevoice-local");
  assert.equal(payload.voiceContext?.metadata.emotion, "calm");
});

test("buildConsoleChatRequestPayload: defaults task mode to false for plain chat payloads", () => {
  const payload = buildConsoleChatRequestPayload({
    text: "你好"
  });

  assert.deepEqual(payload, {
    text: "你好",
    taskMode: false
  });
});
