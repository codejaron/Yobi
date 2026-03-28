import test from "node:test";
import assert from "node:assert/strict";
import type { ChatAttachment, VoiceSessionEvent } from "@shared/types";
import type { VoiceSessionState } from "@shared/types";
import { RealtimeVoiceService } from "../services/realtime-voice.js";
import type { CompanionSpeechCaptureSession } from "../services/companion-mode.js";
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
  captureService?: {
    isNativeSupported?: () => boolean;
    startStream?: () => Promise<void>;
    stopStream?: () => Promise<void>;
    onPcmFrame?: (listener: (frame: { pcm: Buffer; sampleRate: number }) => void) => () => void;
    stop?: () => Promise<void> | void;
  };
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
    onStatusChange: async () => undefined,
    captureService: overrides?.captureService as never
  } as ConstructorParameters<typeof RealtimeVoiceService>[0]);

  return service as any;
}

test("realtime voice: free mode startSession uses native capture service instead of host capture", async () => {
  const steps: string[] = [];
  const service = createService({
    createVad: async () => {
      steps.push("create-vad");
      return createFakeVad(async () => ({
        probability: 0,
        speechStarted: false,
        speechEnded: false,
        speaking: false
      }));
    },
    captureService: {
      isNativeSupported: () => true,
      onPcmFrame: () => () => undefined,
      startStream: async () => {
        steps.push("start-stream");
      },
      stopStream: async () => {
        steps.push("stop-stream");
      }
    }
  });

  service.host = {
    send: async (command: VoiceHostCommand) => {
      steps.push(command.type);
    }
  };

  const started = await service.startSession({
    mode: "free"
  });

  assert.equal(started.phase, "listening");
  assert.equal(service.state.phase, "listening");
  assert.deepEqual(steps, ["create-vad", "start-stream"]);
});

test("realtime voice: ptt hold uses native capture service instead of host capture", async () => {
  const steps: string[] = [];
  const service = createService({
    captureService: {
      isNativeSupported: () => true,
      onPcmFrame: () => () => undefined,
      startStream: async () => {
        steps.push("start-stream");
      },
      stopStream: async () => {
        steps.push("stop-stream");
      }
    }
  });

  service.host = {
    send: async (command: VoiceHostCommand) => {
      steps.push(command.type);
    }
  };
  service.state = createVoiceSessionState({
    sessionId: "session-1",
    mode: "ptt",
    target: {
      resourceId: "primary-user",
      threadId: "primary-thread"
    }
  });

  await service.handlePttPhase("down");
  await service.handlePttPhase("up");

  assert.deepEqual(steps, ["start-stream", "stop-stream"]);
});

function createFakeVad(
  processChunk: VoiceActivityDetector["processChunk"]
): VoiceActivityDetector {
  return {
    processChunk,
    reset: () => undefined,
    dispose: () => undefined
  };
}

function createAttachment(id = "attachment-1"): ChatAttachment {
  return {
    id,
    kind: "image",
    filename: "companion-capture.jpg",
    mimeType: "image/jpeg",
    size: 1234,
    path: `/tmp/${id}.jpg`,
    source: "companion-capture",
    createdAt: "2026-03-14T00:00:00.000Z"
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

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(steps, ["create-vad", "start-capture"]);

  await service.handleHostMessage({
    type: "capture-started"
  });
  await service.handleHostMessage({
    type: "pcm-frame",
    pcm: Array.from(Buffer.alloc(3200)),
    sampleRate: 16_000
  });
  await startPromise;
});

test("realtime voice: free mode startSession waits for the first pcm frame before entering listening", async () => {
  const commands: VoiceHostCommand[] = [];
  const service = createService({
    createVad: async () =>
      createFakeVad(async () => ({
        probability: 0,
        speechStarted: false,
        speechEnded: false,
        speaking: false
      }))
  });

  service.host = {
    send: async (command: VoiceHostCommand) => {
      commands.push(command);
    }
  };

  let resolved = false;
  const startPromise = service.startSession({
    mode: "free"
  }).then((state: VoiceSessionState) => {
    resolved = true;
    return state;
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(commands.map((command) => command.type), ["start-capture"]);
  assert.equal(service.state.phase, "idle");
  assert.equal(resolved, false);

  await service.handleHostMessage({
    type: "capture-started"
  });
  assert.equal(service.state.phase, "idle");
  assert.equal(resolved, false);

  await service.handleHostMessage({
    type: "pcm-frame",
    pcm: Array.from(Buffer.alloc(3200)),
    sampleRate: 16_000
  });
  const started = await startPromise;

  assert.equal(resolved, true);
  assert.equal(started.phase, "listening");
  assert.equal(service.state.phase, "listening");
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

test("realtime voice: slow companion capture at speech start does not drop following speech frames", async () => {
  const pushes: number[] = [];
  const captureStarted = createDeferred<void>();
  const companionCaptureDeferred = createDeferred<CompanionSpeechCaptureSession | null>();
  let vadCallCount = 0;
  const service = createService({
    createVad: async () =>
      createFakeVad(async () => {
        vadCallCount += 1;
        return {
          probability: 0.82,
          speechStarted: vadCallCount === 1,
          speechEnded: false,
          speaking: true
        };
      }),
    voiceRouter: {
      createStreamingAsrSession: () =>
        ({
          pushPcm: async (chunk: Buffer) => {
            pushes.push(chunk[0] ?? 0);
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
  service.setCompanionCaptureHooks({
    captureCompanionSpeechStartContext: async () => {
      captureStarted.resolve();
      return companionCaptureDeferred.promise;
    },
    captureCompanionSpeechRecapture: async () => undefined
  });

  const firstChunk = Buffer.alloc(3200, 1);
  const secondChunk = Buffer.alloc(3200, 2);

  const firstFrame = service.handlePcmFrame(firstChunk, 16_000);
  await captureStarted.promise;
  const secondFrame = service.handlePcmFrame(secondChunk, 16_000);
  await secondFrame;

  assert.deepEqual(pushes, [1, 2]);

  companionCaptureDeferred.resolve({
    attachments: [],
    startedAtMs: Date.now(),
    lastBitmap: Buffer.alloc(4),
    frontWindow: {
      appName: "Safari",
      title: "Example",
      focused: true
    },
    recaptureUsed: false,
    pendingTitleChange: null,
    lastTitleTriggerAtMs: 0,
    nextCheckAtMs: Date.now()
  });

  await firstFrame;
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

test("realtime voice: final user transcript event includes companion attachments", async () => {
  const service = createService();
  const events: VoiceSessionEvent[] = [];
  const attachment = createAttachment();

  service.onEvent((event: VoiceSessionEvent) => {
    events.push(event);
  });
  service.handleUserTurn = async () => undefined;
  service.state = createVoiceSessionState({
    sessionId: "session-1",
    mode: "free",
    target: {
      resourceId: "primary-user",
      threadId: "primary-thread"
    }
  });
  service.speechActive = true;
  service.activeAsrSession = {
    pushPcm: async () => undefined,
    flush: async () => ({
      text: "な",
      metadata: null
    }),
    abort: async () => undefined
  } satisfies StreamingAsrSession;
  service.activeSpeechCaptureSession = {
    attachments: [attachment]
  };

  await service.finishSpeech();

  const transcriptEvent = events.find(
    (event) => event.type === "user-transcript" && event.isFinal
  );
  assert.equal(transcriptEvent?.type, "user-transcript");
  assert.equal(transcriptEvent?.attachments?.length, 1);
  assert.equal(transcriptEvent?.attachments?.[0]?.id, attachment.id);
});
