import test from "node:test";
import assert from "node:assert/strict";
import { RealtimeVoiceService } from "../services/realtime-voice.js";
import { createVoiceSessionState } from "../services/realtime-voice-state.js";
import type { VoiceHostCommand } from "../services/voice-host-window.js";
import type { StreamingTtsSession } from "../services/voice-router.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    void rej;
  });

  return {
    promise,
    resolve
  };
}

function createService() {
  const service = new RealtimeVoiceService({
    paths: {} as never,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    } as never,
    getConfig: () =>
      ({
        realtimeVoice: {
          enabled: true,
          mode: "free",
          aecEnabled: true,
          autoInterrupt: true,
          preRollMs: 300,
          vadThreshold: 0.35,
          maxUtteranceMs: 10000,
          minSpeechMs: 300,
          minSilenceMs: 500,
          firstChunkStrategy: "aggressive"
        },
        voice: {
          ttsVoice: "stub-voice",
          ttsRate: "+0%",
          ttsPitch: "+0Hz",
          requestTimeoutMs: 5000,
          retryCount: 0,
          asrProvider: "sensevoice-local",
          ttsProvider: "edge"
        }
      }) as never,
    voiceRouter: {} as never,
    conversation: {
      rememberAssistantMessage: async () => undefined
    } as never,
    memory: {} as never,
    defaultTarget: {
      resourceId: "primary-user",
      threadId: "primary-thread"
    },
    onRecordUserActivity: async () => undefined,
    onAssistantMessage: async () => undefined,
    onStatusChange: async () => undefined
  } as ConstructorParameters<typeof RealtimeVoiceService>[0]);

  return service as any;
}

test("realtime voice: stopSession blocks in-flight tts chunks from re-enqueueing playback", async () => {
  const commands: VoiceHostCommand[] = [];
  const synthDeferred = createDeferred<Buffer>();
  const fakeSession: StreamingTtsSession = {
    synthesizeChunk: async () => synthDeferred.promise,
    close: async () => undefined
  };
  const service = createService();

  service.host = {
    send: async (command) => {
      commands.push(command);
    }
  };
  service.state = createVoiceSessionState({
    sessionId: "session-1",
    mode: "free",
    target: {
      resourceId: "primary-user",
      threadId: "primary-thread"
    }
  });
  service.activeTtsSession = fakeSession;
  service.playbackGeneration = 1;

  const enqueuePromise = service.enqueueTtsChunk("你好呀", fakeSession, 1);
  await Promise.resolve();

  const stopResult = await service.stopSession();
  synthDeferred.resolve(Buffer.from("audio"));
  await enqueuePromise;

  assert.equal(stopResult.accepted, true);
  assert.deepEqual(
    commands.map((command) => command.type),
    ["stop-capture", "clear-playback"]
  );
});
