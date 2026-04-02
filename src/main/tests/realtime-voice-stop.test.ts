import test from "node:test";
import assert from "node:assert/strict";
import type { ChatAttachment, VoiceSessionEvent } from "@shared/types";
import type { VoiceSessionState } from "@shared/types";
import { RealtimeVoiceService } from "../services/realtime-voice.js";
import type { CompanionSpeechCaptureSession } from "../services/companion-mode.js";
import { createVoiceSessionState, reduceVoiceSessionState } from "../services/realtime-voice-state.js";
import type { VoiceActivityDetector } from "../services/realtime-voice-vad.js";
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
  conversation?: Partial<ConstructorParameters<typeof RealtimeVoiceService>[0]["conversation"]>;
  memory?: Partial<ConstructorParameters<typeof RealtimeVoiceService>[0]["memory"]>;
  captureService?: {
    isNativeSupported?: () => boolean;
    startStream?: () => Promise<void>;
    stopStream?: () => Promise<void>;
    onPcmFrame?: (listener: (frame: { pcm: Buffer; sampleRate: number }) => void) => () => void;
    stop?: () => Promise<void> | void;
  };
  playbackBridge?: {
    enqueueSpeech?: (input: unknown) => Promise<boolean> | boolean;
    clearSpeech?: (input: unknown) => Promise<boolean> | boolean;
    onVoiceEvent?: (listener: (event: unknown) => void) => () => void;
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
      createStreamingTtsSession: () =>
        ({
          synthesizeChunk: async () => Buffer.from("audio"),
          close: async () => undefined
        }) satisfies StreamingTtsSession,
      ...(overrides?.voiceRouter ?? {})
    } as never,
    createVad: overrides?.createVad,
    conversation: {
      reply: async () => "",
      rememberAssistantMessage: async () => undefined,
      ...(overrides?.conversation ?? {})
    } as never,
    memory: {
      rememberMessage: async () => undefined,
      ...(overrides?.memory ?? {})
    } as never,
    defaultTarget: {
      resourceId: "primary-user",
      threadId: "primary-thread"
    },
    onRecordUserActivity: async () => undefined,
    onAssistantMessage: async () => undefined,
    onStatusChange: async () => undefined,
    captureService: overrides?.captureService as never,
    playbackBridge: overrides?.playbackBridge as never
  } as any);

  return service as any;
}

function createPlaybackBridge(overrides?: {
  onEnqueue?: (input: any) => void;
  onClear?: (input: any) => void;
}) {
  let listener: ((event: any) => void) | null = null;
  return {
    enqueueSpeech: async (input: any) => {
      overrides?.onEnqueue?.(input);
      return true;
    },
    clearSpeech: async (input: any) => {
      overrides?.onClear?.(input);
      return true;
    },
    onVoiceEvent: (next: (event: any) => void) => {
      listener = next;
      return () => {
        if (listener === next) {
          listener = null;
        }
      };
    },
    emit(event: any) {
      listener?.(event);
    }
  };
}

async function emitReferenceFrame(service: any, input: {
  generation: number;
  pcm: Buffer;
  sampleRate?: number;
  active?: boolean;
  pendingCount?: number;
}): Promise<void> {
  await service.handlePlaybackEvent({
    type: "reference-frame",
    generation: input.generation,
    pcm: input.pcm,
    sampleRate: input.sampleRate ?? 16_000,
    state: {
      generation: input.generation,
      active: input.active ?? true,
      currentChunkId: null,
      currentText: "",
      queuedCount: 0,
      pendingCount: input.pendingCount ?? 0
    }
  });
}

test("realtime voice: free mode startSession always uses native capture when supported", async () => {
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
    send: async (command: { type: string }) => {
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

test("realtime voice: free mode can still use native capture when AEC is disabled", async () => {
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
    getConfig: () =>
      ({
        realtimeVoice: {
          enabled: true,
          mode: "free",
          aecEnabled: false,
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
    send: async (command: { type: string }) => {
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

test("realtime voice: ptt hold always uses native capture when supported", async () => {
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
    send: async (command: { type: string }) => {
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

test("realtime voice: ptt hold can still use native capture when AEC is disabled", async () => {
  const steps: string[] = [];
  const service = createService({
    getConfig: () =>
      ({
        realtimeVoice: {
          enabled: true,
          mode: "free",
          aecEnabled: false,
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
    send: async (command: { type: string }) => {
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

function makeSineChunk(
  frequencyHz: number,
  amplitude = 12_000,
  sampleRate = 16_000,
  sampleCount = 320
): Buffer {
  const pcm = Buffer.alloc(sampleCount * 2);

  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.round(
      Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate) * amplitude
    );
    pcm.writeInt16LE(value, index * 2);
  }

  return pcm;
}

function makeNoiseChunk(seed = 7, amplitude = 14_000, sampleCount = 320): Buffer {
  const pcm = Buffer.alloc(sampleCount * 2);
  let state = seed >>> 0;

  for (let index = 0; index < sampleCount; index += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const normalized = (state / 0xffffffff) * 2 - 1;
    const value = Math.round(normalized * amplitude);
    pcm.writeInt16LE(value, index * 2);
  }

  return pcm;
}

function delayAndScaleChunk(
  input: Buffer,
  delaySamples: number,
  gain: number,
  noiseAmplitude = 0
): Buffer {
  const sampleCount = Math.floor(input.length / 2);
  const delayed = Buffer.alloc(input.length);
  let state = 17 >>> 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const sourceIndex = index - delaySamples;
    const sourceSample = sourceIndex >= 0 ? input.readInt16LE(sourceIndex * 2) : 0;
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    const noise = noiseAmplitude > 0 ? (((state / 0xffffffff) * 2 - 1) * noiseAmplitude) : 0;
    const value = Math.round(sourceSample * gain + noise);
    delayed.writeInt16LE(Math.max(-0x8000, Math.min(0x7fff, value)), index * 2);
  }

  return delayed;
}

function sliceFrame(input: Buffer, frameIndex: number, frameSamples = 320): Buffer {
  const start = frameIndex * frameSamples * 2;
  return input.subarray(start, start + frameSamples * 2);
}

test("realtime voice: stopSession blocks in-flight tts chunks from re-enqueueing playback", async () => {
  const steps: string[] = [];
  const synthDeferred = createDeferred<Buffer>();
  const fakeSession: StreamingTtsSession = {
    synthesizeChunk: async () => synthDeferred.promise,
    close: async () => undefined
  };
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
    },
    playbackBridge: createPlaybackBridge({
      onClear: () => {
        steps.push("speech-clear");
      }
    })
  });

  service.host = {
    send: async (command: { type: string }) => {
      steps.push(command.type);
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
  assert.deepEqual(steps, ["stop-stream", "speech-clear"]);
});

test("realtime voice: speech start interrupts assistant thinking before opening a new ASR session", async () => {
  const order: string[] = [];
  const service = createService({
    playbackBridge: createPlaybackBridge({
      onClear: () => {
        order.push("speech-clear");
      }
    }),
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
    send: async (command: { type: string }) => {
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
  assert.deepEqual(order, ["speech-clear", "create-asr"]);
  assert.equal(service.state.phase, "user-speaking");
  assert.equal(service.speechActive, true);
  assert.ok(service.activeAsrSession);
});

test("realtime voice: playback-matching echo does not trigger a new speech start", async () => {
  const order: string[] = [];
  const service = createService({
    createVad: async () =>
      createFakeVad(async () => ({
        probability: 0.88,
        speechStarted: true,
        speechEnded: false,
        speaking: true
      })),
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

  service.host = {
    send: async (command: { type: string }) => {
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
  service.playbackGeneration = 1;
  service.state = reduceVoiceSessionState(service.state, {
    type: "assistant-playback-started"
  });

  const echoedPlayback = makeSineChunk(440);
  await emitReferenceFrame(service, {
    generation: 1,
    pcm: echoedPlayback
  });
  await service.handlePcmFrame(echoedPlayback, 16_000);

  assert.equal(service.state.phase, "assistant-speaking");
  assert.equal(service.state.playback.active, true);
  assert.equal(service.speechActive, false);
  assert.deepEqual(order, []);
  assert.equal(service.activeAsrSession, null);
});

test("realtime voice: delayed playback echo still does not trigger a new speech start", async () => {
  const order: string[] = [];
  const service = createService({
    createVad: async () =>
      createFakeVad(async () => ({
        probability: 0.88,
        speechStarted: true,
        speechEnded: false,
        speaking: true
      })),
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

  service.host = {
    send: async (command: { type: string }) => {
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
  service.playbackGeneration = 1;
  service.state = reduceVoiceSessionState(service.state, {
    type: "assistant-playback-started"
  });

  const playbackReference = makeNoiseChunk(11, 11_000);
  const delayedEcho = delayAndScaleChunk(playbackReference, 42, 0.58, 220);

  await emitReferenceFrame(service, {
    generation: 1,
    pcm: playbackReference
  });
  await service.handlePcmFrame(delayedEcho, 16_000);

  assert.equal(service.state.phase, "assistant-speaking");
  assert.equal(service.state.playback.active, true);
  assert.equal(service.speechActive, false);
  assert.deepEqual(order, []);
  assert.equal(service.activeAsrSession, null);
});

test("realtime voice: longer delayed playback echo still does not trigger a new speech start", async () => {
  const order: string[] = [];
  const service = createService({
    createVad: async () =>
      createFakeVad(async () => ({
        probability: 0.88,
        speechStarted: true,
        speechEnded: false,
        speaking: true
      })),
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

  service.host = {
    send: async (command: { type: string }) => {
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
  service.playbackGeneration = 1;
  service.state = reduceVoiceSessionState(service.state, {
    type: "assistant-playback-started"
  });

  const totalFrames = 30;
  const delayFrames = 12;
  const playbackReference = makeNoiseChunk(23, 11_000, 320 * totalFrames);
  const delayedEcho = delayAndScaleChunk(playbackReference, 320 * delayFrames, 0.58, 220);
  const originalDateNow = Date.now;

  try {
    for (let frameIndex = 0; frameIndex <= delayFrames; frameIndex += 1) {
      Date.now = () => 6_000 + frameIndex * 20;
      await emitReferenceFrame(service, {
        generation: 1,
        pcm: sliceFrame(playbackReference, frameIndex)
      });
    }

    Date.now = () => 6_000 + delayFrames * 20;
    await service.handlePcmFrame(sliceFrame(delayedEcho, delayFrames), 16_000);
  } finally {
    Date.now = originalDateNow;
  }

  assert.equal(service.state.phase, "assistant-speaking");
  assert.equal(service.state.playback.active, true);
  assert.equal(service.speechActive, false);
  assert.deepEqual(order, []);
  assert.equal(service.activeAsrSession, null);
});

test("realtime voice: distinct user speech can still barge in during assistant playback", async () => {
  const order: string[] = [];
  const playbackBridge = createPlaybackBridge({
    onClear: () => {
      order.push("speech-clear");
    }
  });
  const service = createService({
    playbackBridge,
    createVad: async () =>
      createFakeVad(async () => ({
        probability: 0.88,
        speechStarted: true,
        speechEnded: false,
        speaking: true
      })),
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
    send: async (command: { type: string }) => {
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
  service.playbackGeneration = service.playbackController.beginGeneration();
  service.state = reduceVoiceSessionState(service.state, {
    type: "assistant-playback-started"
  });
  service.replyAbortController = abortController;

  await emitReferenceFrame(service, {
    generation: 1,
    pcm: makeSineChunk(440)
  });
  await service.handlePcmFrame(makeSineChunk(1_260, 16_000), 16_000);

  assert.equal(abortController.signal.aborted, true);
  assert.deepEqual(order, ["speech-clear", "create-asr"]);
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

test("realtime voice: startSession waits for async VAD warmup before starting native microphone capture", async () => {
  const steps: string[] = [];
  const deferred = createDeferred<VoiceActivityDetector>();
  const service = createService({
    createVad: async () => {
      steps.push("create-vad");
      return deferred.promise;
    },
    captureService: {
      isNativeSupported: () => true,
      onPcmFrame: () => () => undefined,
      startStream: async () => {
        steps.push("start-stream");
      },
      stopStream: async () => undefined
    }
  });

  service.host = {
    send: async (command: { type: string }) => {
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
  assert.deepEqual(steps, ["create-vad", "start-stream"]);
  await startPromise;
});

test("realtime voice: free mode startSession enters listening when native stream starts", async () => {
  const steps: string[] = [];
  const deferred = createDeferred<void>();
  const service = createService({
    createVad: async () =>
      createFakeVad(async () => ({
        probability: 0,
        speechStarted: false,
        speechEnded: false,
          speaking: false
        })),
    captureService: {
      isNativeSupported: () => true,
      onPcmFrame: () => () => undefined,
      startStream: async () => {
        steps.push("start-stream");
        await deferred.promise;
      },
      stopStream: async () => {
        steps.push("stop-stream");
      }
    }
  });

  service.host = {
    send: async (command: { type: string }) => {
      steps.push(command.type);
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

  assert.deepEqual(steps, ["start-stream"]);
  assert.equal(service.state.phase, "idle");
  assert.equal(resolved, false);

  deferred.resolve();
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

test("realtime voice: handleUserTurn should not pre-persist the same user turn before conversation.reply", async () => {
  let rememberedUserTurns = 0;
  let seenReplyInput: any = null;
  const service = createService({
    conversation: {
      reply: async (input: any) => {
        seenReplyInput = input;
        return "收到";
      }
    },
    memory: {
      rememberMessage: async () => {
        rememberedUserTurns += 1;
      }
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

  await service.handleUserTurn(
    "可以听到吗",
    {
      language: "zh",
      emotion: null,
      event: null,
      rawTags: []
    },
    []
  );

  assert.equal(rememberedUserTurns, 0);
  assert.equal(seenReplyInput?.persistUserMessage, undefined);
  assert.deepEqual(seenReplyInput?.userMetadata, {
    voice: {
      source: "voice",
      sessionId: "session-1",
      mode: "free",
      interrupted: false,
      playedTextLength: 0,
      asrProvider: "sensevoice-local",
      ttsProvider: "edge"
    }
  });
});

test("realtime voice: sustained silence force-finishes a stuck speech turn when VAD stays latched", async () => {
  let callCount = 0;
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
            maxUtteranceMs: 45_000,
            minSpeechMs: 180,
            minSilenceMs: 600,
            firstChunkStrategy: "aggressive"
          },
          voice: {
            ttsVoice: "stub-voice",
            ttsRate: "+0%",
            ttsPitch: "+0Hz",
            requestTimeoutMs: 50,
            retryCount: 0,
            asrProvider: "sensevoice-local",
            ttsProvider: "edge"
          }
        }) as never,
      createVad: async () =>
        createFakeVad(async () => {
          callCount += 1;
          return {
            probability: callCount === 1 ? 0.92 : 0.04,
            speechStarted: callCount === 1,
            speechEnded: false,
            speaking: true
          };
        }),
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

    await service.handlePcmFrame(Buffer.alloc(3200, 1), 16_000);
    nowMs = 900;
    await service.handlePcmFrame(Buffer.alloc(3200), 16_000);
    nowMs = 1_800;
    await service.handlePcmFrame(Buffer.alloc(3200), 16_000);
    nowMs = 2_700;
    await service.handlePcmFrame(Buffer.alloc(3200), 16_000);

    assert.equal(flushCount, 1);
    assert.equal(service.speechActive, false);
    assert.equal(service.state.phase, "listening");
  } finally {
    Date.now = originalDateNow;
  }
});

test("realtime voice: transcribing timeout recovers the session when ASR flush hangs", async () => {
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
          maxUtteranceMs: 45_000,
          minSpeechMs: 180,
          minSilenceMs: 600,
          firstChunkStrategy: "aggressive"
        },
        voice: {
          ttsVoice: "stub-voice",
          ttsRate: "+0%",
          ttsPitch: "+0Hz",
          requestTimeoutMs: 20,
          retryCount: 0,
          asrProvider: "sensevoice-local",
          ttsProvider: "edge"
        }
      }) as never
  });

  service.host = {
    send: async () => undefined
  };
  service.state = reduceVoiceSessionState(
    createVoiceSessionState({
      sessionId: "session-1",
      mode: "free",
      target: {
        resourceId: "primary-user",
        threadId: "primary-thread"
      }
    }),
    {
      type: "speech-started"
    }
  );
  service.speechActive = true;
  service.activeAsrSession = {
    pushPcm: async () => undefined,
    flush: async () => new Promise(() => undefined),
    abort: async () => undefined
  } satisfies StreamingAsrSession;

  void service.finishSpeech();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(service.speechActive, false);
  assert.equal(service.state.phase, "listening");
});

test("realtime voice: assistant progress watchdog aborts silent thinking and returns to listening", async () => {
  let seenAbortSignal: AbortSignal | null = null;
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
          maxUtteranceMs: 45_000,
          minSpeechMs: 180,
          minSilenceMs: 600,
          firstChunkStrategy: "aggressive"
        },
        voice: {
          ttsVoice: "stub-voice",
          ttsRate: "+0%",
          ttsPitch: "+0Hz",
          requestTimeoutMs: 20,
          retryCount: 0,
          asrProvider: "sensevoice-local",
          ttsProvider: "edge"
        }
      }) as never,
    conversation: {
      reply: async (input: any) => {
        seenAbortSignal = input.abortSignal ?? null;
        return await new Promise<string>((_resolve, reject) => {
          input.abortSignal?.addEventListener(
            "abort",
            () => {
              reject(new Error("aborted"));
            },
            {
              once: true
            }
          );
        });
      }
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

  void service.handleUserTurn("可以听到吗", null, []);
  await new Promise((resolve) => setTimeout(resolve, 70));

  assert.equal((seenAbortSignal as AbortSignal | null)?.aborted ?? false, true);
  assert.equal(service.state.phase, "listening");
  assert.equal(service.state.assistantTranscript, "");
});

test("realtime voice: playback start watchdog recovers when queued speech never starts", async () => {
  let clearCount = 0;
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
          maxUtteranceMs: 45_000,
          minSpeechMs: 180,
          minSilenceMs: 600,
          firstChunkStrategy: "aggressive"
        },
        voice: {
          ttsVoice: "stub-voice",
          ttsRate: "+0%",
          ttsPitch: "+0Hz",
          requestTimeoutMs: 80,
          retryCount: 0,
          asrProvider: "sensevoice-local",
          ttsProvider: "edge"
        }
      }) as never,
    conversation: {
      reply: async (input: any) => {
        input.stream?.onVisibleTextDelta?.("这是一段足够长的语音回复，可以进入播报。");
        input.stream?.onVisibleTextFinal?.("这是一段足够长的语音回复，可以进入播报。");
        return "这是一段足够长的语音回复，可以进入播报。";
      }
    },
    playbackBridge: createPlaybackBridge({
      onClear: () => {
        clearCount += 1;
      }
    })
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

  await service.handleUserTurn("测试播放启动卡死", null, []);
  await new Promise((resolve) => setTimeout(resolve, 90));

  assert.equal(clearCount > 0, true);
  assert.equal(service.state.phase, "listening");
  assert.equal(service.state.errorMessage, null);
});

test("realtime voice: queued speech stays in thinking until playback actually starts", async () => {
  const enqueued: string[] = [];
  const service = createService({
    conversation: {
      reply: async (input: any) => {
        input.stream?.onVisibleTextDelta?.("这是一段足够长的语音回复，可以进入播报。");
        input.stream?.onVisibleTextFinal?.("这是一段足够长的语音回复，可以进入播报。");
        return "这是一段足够长的语音回复，可以进入播报。";
      }
    },
    playbackBridge: createPlaybackBridge({
      onEnqueue: (input) => {
        enqueued.push(String(input?.chunkId ?? ""));
      }
    })
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

  void service.handleUserTurn("测试准备阶段", null, []);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(enqueued.length > 0, true);
  assert.equal(service.state.phase, "assistant-thinking");
});

test("realtime voice: reference frames prevent false playback-start timeout when started ack is missed", async () => {
  let clearCount = 0;
  let firstChunkGeneration: number | null = null;
  const bridge = createPlaybackBridge({
    onEnqueue: (input) => {
      if (firstChunkGeneration === null) {
        firstChunkGeneration = Number(input?.generation ?? 0);
      }
    },
    onClear: () => {
      clearCount += 1;
    }
  });
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
          maxUtteranceMs: 45_000,
          minSpeechMs: 180,
          minSilenceMs: 600,
          firstChunkStrategy: "aggressive"
        },
        voice: {
          ttsVoice: "stub-voice",
          ttsRate: "+0%",
          ttsPitch: "+0Hz",
          requestTimeoutMs: 80,
          retryCount: 0,
          asrProvider: "sensevoice-local",
          ttsProvider: "edge"
        }
      }) as never,
    conversation: {
      reply: async (input: any) => {
        input.stream?.onVisibleTextDelta?.("这是一段足够长的语音回复，可以进入播报。");
        input.stream?.onVisibleTextFinal?.("这是一段足够长的语音回复，可以进入播报。");
        return "这是一段足够长的语音回复，可以进入播报。";
      }
    },
    playbackBridge: bridge
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

  void service.handleUserTurn("测试 started 丢失", null, []);
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.notEqual(firstChunkGeneration, null);
  if (firstChunkGeneration === null) {
    throw new Error("expected first playback chunk to be enqueued");
  }
  bridge.emit({
    type: "speech-reference-frame",
    pcm: [0, 0, 0, 0],
    sampleRate: 16_000,
    generation: firstChunkGeneration
  });
  await new Promise((resolve) => setTimeout(resolve, 90));

  assert.equal(clearCount, 0);
  assert.equal(service.state.phase, "assistant-speaking");
});

test("realtime voice: stale assistant callbacks are ignored after an interrupt", async () => {
  let capturedStream: {
    onVisibleTextDelta?: (delta: string) => void;
    onVisibleTextFinal?: (text: string) => void;
    onAbortVisibleText?: (text: string) => void;
  } | null = null;
  const service = createService({
    conversation: {
      reply: async (input: any) => {
        capturedStream = input.stream ?? null;
        return await new Promise<string>(() => undefined);
      }
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

  void service.handleUserTurn("旧的一轮", null, []);
  await Promise.resolve();
  await service.interrupt("manual");

  const staleStream = capturedStream as {
    onVisibleTextDelta?: (delta: string) => void;
    onVisibleTextFinal?: (text: string) => void;
    onAbortVisibleText?: (text: string) => void;
  } | null;

  staleStream?.onVisibleTextDelta?.("迟到的文本");
  staleStream?.onVisibleTextFinal?.("迟到的最终文本");
  staleStream?.onAbortVisibleText?.("迟到的中断文本");

  assert.equal(service.state.phase, "interrupted");
  assert.equal(service.state.assistantTranscript, "");
});

test("realtime voice: terminated abort errors do not transition interrupted sessions to error", async () => {
  let seenAbortSignal: AbortSignal | null = null;
  const service = createService({
    conversation: {
      reply: async (input: any) => {
        seenAbortSignal = input.abortSignal ?? null;
        return await new Promise<string>((_resolve, reject) => {
          input.abortSignal?.addEventListener(
            "abort",
            () => {
              reject(new TypeError("terminated"));
            },
            {
              once: true
            }
          );
        });
      }
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

  void service.handleUserTurn("先打断这轮", null, []);
  await Promise.resolve();
  await service.interrupt("manual");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal((seenAbortSignal as AbortSignal | null)?.aborted ?? false, true);
  assert.equal(service.state.phase, "interrupted");
  assert.equal(service.state.errorMessage, null);
  assert.equal(service.state.assistantTranscript, "");
});

test("realtime voice: abort-like terminated reply failures recover back to listening", async () => {
  const service = createService({
    conversation: {
      reply: async () => {
        throw new TypeError("terminated");
      }
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

  await service.handleUserTurn("网络波动", null, []);

  assert.equal(service.state.phase, "listening");
  assert.equal(service.state.errorMessage, null);
  assert.equal(service.state.assistantTranscript, "");
});
