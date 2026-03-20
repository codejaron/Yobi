import test from "node:test";
import assert from "node:assert/strict";
import { RealtimeVoiceService } from "../services/realtime-voice.js";
import { createVoiceSessionState, reduceVoiceSessionState } from "../services/realtime-voice-state.js";
import type { VoiceActivityDetector } from "../services/realtime-voice-vad.js";
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
  createVad?: ConstructorParameters<typeof RealtimeVoiceService>[0]["createVad"];
  getConfig?: ConstructorParameters<typeof RealtimeVoiceService>[0]["getConfig"];
}) {
  const service = new RealtimeVoiceService({
    paths: {} as never,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    } as never,
    getConfig:
      overrides?.getConfig ??
      (() =>
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
      }) as never),
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
    createVad: overrides?.createVad,
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

function createFakeVad(
  processChunk: VoiceActivityDetector["processChunk"]
): VoiceActivityDetector {
  return {
    processChunk,
    reset: () => undefined,
    dispose: () => undefined
  };
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

test("realtime voice: startSession waits for async VAD warmup before starting microphone capture", async () => {
  const steps: string[] = [];
  const deferred = createDeferred<VoiceActivityDetector>();
  const service = createService({
    createVad: async () => {
      steps.push("create-vad");
      return deferred.promise;
    }
  });

  service.host = {
    send: async (command: VoiceHostCommand) => {
      steps.push(command.type);
    }
  };

  const startPromise = service.startSession({
    mode: "free"
  });
  await Promise.resolve();

  assert.deepEqual(steps, ["create-vad"]);

  deferred.resolve(
    createFakeVad(async () => ({
      probability: 0,
      speechStarted: false,
      speechEnded: false,
      speaking: false
    }))
  );

  await startPromise;
  assert.deepEqual(steps, ["create-vad", "start-capture"]);
});

test("realtime voice: free mode speech start opens ASR and pushes the triggering chunk", async () => {
  const pushes: number[] = [];
  const service = createService({
    createVad: async () =>
      createFakeVad(async () => ({
        probability: 0.82,
        speechStarted: true,
        speechEnded: false,
        speaking: true
      })),
    voiceRouter: {
      createStreamingAsrSession: () =>
        ({
          pushPcm: async (chunk: Buffer) => {
            pushes.push(chunk.length);
          },
          flush: async () => ({
            text: "",
            metadata: null
          }),
          abort: async () => undefined
        }) satisfies StreamingAsrSession
    }
  });

  service.host = {
    send: async () => undefined
  };
  service.state = createVoiceSessionState({
    sessionId: "session-1",
    mode: "free",
    target: {
      resourceId: "primary-user",
      threadId: "primary-thread"
    }
  });

  const chunk = Buffer.alloc(3200);
  await service.handlePcmFrame(chunk, 16_000);

  assert.equal(service.speechActive, true);
  assert.deepEqual(pushes, [3200]);
});

test("realtime voice: free mode speech end flushes after pushing the ending chunk", async () => {
  const order: string[] = [];
  let callCount = 0;
  const service = createService({
    createVad: async () =>
      createFakeVad(async () => {
        callCount += 1;
        return {
          probability: callCount === 1 ? 0.9 : 0.1,
          speechStarted: callCount === 1,
          speechEnded: callCount === 2,
          speaking: callCount === 1
        };
      }),
    voiceRouter: {
      createStreamingAsrSession: () =>
        ({
          pushPcm: async (_chunk: Buffer) => {
            order.push(`push-${callCount}`);
          },
          flush: async () => {
            order.push("flush");
            return {
              text: "",
              metadata: null
            };
          },
          abort: async () => undefined
        }) satisfies StreamingAsrSession
    }
  });

  service.host = {
    send: async () => undefined
  };
  service.state = createVoiceSessionState({
    sessionId: "session-1",
    mode: "free",
    target: {
      resourceId: "primary-user",
      threadId: "primary-thread"
    }
  });

  await service.handlePcmFrame(Buffer.alloc(3200), 16_000);
  await service.handlePcmFrame(Buffer.alloc(3200), 16_000);

  assert.deepEqual(order, ["push-1", "push-2", "flush"]);
  assert.equal(service.speechActive, false);
});

test("realtime voice: maxUtteranceMs still forces a flush when VAD keeps speaking", async () => {
  let flushCount = 0;
  const originalDateNow = Date.now;
  let nowMs = 0;
  Date.now = () => nowMs;

  try {
    const service = createService({
      getConfig: () =>
        ({
          realtimeVoice: {
            enabled: true,
            mode: "free",
            aecEnabled: true,
            autoInterrupt: true,
            preRollMs: 300,
            vadThreshold: 0.35,
            maxUtteranceMs: 1000,
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
      createVad: async () =>
        createFakeVad(async () => ({
          probability: 0.91,
          speechStarted: nowMs === 0,
          speechEnded: false,
          speaking: true
        })),
      voiceRouter: {
        createStreamingAsrSession: () =>
          ({
            pushPcm: async () => undefined,
            flush: async () => {
              flushCount += 1;
              return {
                text: "",
                metadata: null
              };
            },
            abort: async () => undefined
          }) satisfies StreamingAsrSession
      }
    });

    service.host = {
      send: async () => undefined
    };
    service.state = createVoiceSessionState({
      sessionId: "session-1",
      mode: "free",
      target: {
        resourceId: "primary-user",
        threadId: "primary-thread"
      }
    });

    await service.handlePcmFrame(Buffer.alloc(3200), 16_000);
    nowMs = 1500;
    await service.handlePcmFrame(Buffer.alloc(3200), 16_000);

    assert.equal(flushCount, 1);
    assert.equal(service.speechActive, false);
  } finally {
    Date.now = originalDateNow;
  }
});
