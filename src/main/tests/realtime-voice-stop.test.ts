import test from "node:test";
import assert from "node:assert/strict";
import { RealtimeVoiceService } from "../services/realtime-voice.js";
import { createVoiceSessionState, reduceVoiceSessionState } from "../services/realtime-voice-state.js";
import type { VoiceHostCommand } from "../services/voice-host-window.js";
import type { StreamingAsrSession, StreamingTtsSession } from "../services/voice-router.js";

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

function createService(overrides?: {
  voiceRouter?: Partial<ConstructorParameters<typeof RealtimeVoiceService>[0]["voiceRouter"]>;
}) {
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
    voiceRouter: {
      createStreamingAsrSession: () =>
        ({
          pushPcm: async () => undefined,
          flush: async () => ({
            text: "",
            metadata: null
          }),
          abort: async () => undefined
        }) satisfies StreamingAsrSession,
      ...(overrides?.voiceRouter ?? {})
    } as never,
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
    send: async (command: VoiceHostCommand) => {
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

test("realtime voice: speech start interrupts assistant thinking before opening a new ASR session", async () => {
  const order: string[] = [];
  const service = createService({
    voiceRouter: {
      createStreamingAsrSession: () => {
        order.push("create-asr");
        return {
          pushPcm: async () => undefined,
          flush: async () => ({
            text: "",
            metadata: null
          }),
          abort: async () => undefined
        } satisfies StreamingAsrSession;
      }
    }
  });
  const abortController = new AbortController();

  service.host = {
    send: async (command: VoiceHostCommand) => {
      order.push(command.type);
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
  service.state = reduceVoiceSessionState(service.state, {
    type: "assistant-thinking-started"
  });
  service.replyAbortController = abortController;

  await service.beginSpeech();

  assert.equal(abortController.signal.aborted, true);
  assert.deepEqual(order, ["clear-playback", "create-asr"]);
  assert.equal(service.state.phase, "user-speaking");
  assert.equal(service.speechActive, true);
  assert.ok(service.activeAsrSession);
});

test("realtime voice: beginSpeech clears stale transcripts from the previous turn", async () => {
  const service = createService();

  service.state = {
    ...createVoiceSessionState({
      sessionId: "session-1",
      mode: "free",
      target: {
        resourceId: "primary-user",
        threadId: "primary-thread"
      }
    }),
    phase: "listening",
    userTranscript: "上一次的问题",
    assistantTranscript: "上一次的回复"
  };

  await service.beginSpeech();

  assert.equal(service.state.phase, "user-speaking");
  assert.equal(service.state.userTranscript, "");
  assert.equal(service.state.assistantTranscript, "");
  assert.equal(service.speechActive, true);
});
