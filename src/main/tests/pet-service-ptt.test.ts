import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "@shared/types";
import { PetService } from "@main/services/pet-service";
import type { VoiceSessionEvent } from "@shared/types";

function createService(overrides?: {
  getConfig?: ConstructorParameters<typeof PetService>[0]["getConfig"];
  globalPtt?: {
    start?: (input: {
      hotkey: string;
      onPrepare?: () => void;
      onPhase: (phase: "down" | "up") => void;
    }) => Promise<void> | void;
    stop?: () => void;
  };
  nativeAudioCapture?: {
    isNativeSupported?: () => boolean;
    warmup?: () => Promise<void>;
    prepare?: () => Promise<void>;
  };
  isPetOnline?: () => boolean;
  isAsrReady?: () => boolean;
  transcribePcm16?: () => Promise<{ text: string; metadata?: unknown }>;
  ensureGlobalPttPermission?: () => boolean;
}) {
  const emittedPetEvents: any[] = [];
  let realtimeVoiceListener: ((event: VoiceSessionEvent) => void) | null = null;

  const service = new PetService({
    paths: {} as never,
    getConfig:
      overrides?.getConfig ??
      (() =>
        ({
          ...DEFAULT_CONFIG,
          pet: {
            ...DEFAULT_CONFIG.pet,
            enabled: true
          },
          ptt: {
            ...DEFAULT_CONFIG.ptt,
            enabled: true,
            hotkey: "Alt+Space"
          },
          realtimeVoice: {
            ...DEFAULT_CONFIG.realtimeVoice,
            enabled: false,
            mode: "ptt"
          }
        }) as never),
    pet: {
      isOnline: overrides?.isPetOnline ?? (() => true),
      emitEvent: (event: any) => {
        emittedPetEvents.push(event);
      },
      close: () => undefined
    } as never,
    stateStore: {
      subscribe: () => undefined
    } as never,
    voiceRouter: {
      isAsrReady: overrides?.isAsrReady ?? (() => true),
      transcribePcm16:
        overrides?.transcribePcm16 ??
        (async () => ({
          text: "你好"
        }))
    } as never,
    realtimeVoice: {
      onEvent: (listener: (event: VoiceSessionEvent) => void) => {
        realtimeVoiceListener = listener;
        return () => {
          realtimeVoiceListener = null;
        };
      },
      stop: () => undefined,
      start: () => undefined,
      isActive: () => false,
      handlePttPhase: async () => undefined
    } as never,
    globalPtt: {
      start: overrides?.globalPtt?.start ?? (async () => undefined),
      stop: overrides?.globalPtt?.stop ?? (() => undefined)
    } as never,
    nativeAudioCapture: {
      isNativeSupported: overrides?.nativeAudioCapture?.isNativeSupported ?? (() => true),
      warmup: overrides?.nativeAudioCapture?.warmup ?? (async () => undefined),
      prepare: overrides?.nativeAudioCapture?.prepare ?? (async () => undefined)
    },
    systemPermissionsService: {
      ensureGlobalPttPermission: overrides?.ensureGlobalPttPermission ?? (() => true)
    } as never,
    channelRouter: {} as never,
    primaryResourceId: "primary-user",
    primaryThreadId: "primary-thread",
    chatReplyTimeoutMs: 1000,
    withTimeout: async <T>(promise: Promise<T>) => promise,
    onStatusChange: async () => undefined
  });

  return Object.assign(service, {
    emittedPetEvents,
    emitRealtimeVoiceEvent(event: VoiceSessionEvent) {
      realtimeVoiceListener?.(event);
    }
  });
}

test("pet service: syncing legacy global ptt warms native capture in background", async () => {
  const calls: string[] = [];
  const service = createService({
    globalPtt: {
      start: async () => {
        calls.push("start");
      }
    },
    nativeAudioCapture: {
      isNativeSupported: () => true,
      warmup: async () => {
        calls.push("warmup");
      }
    }
  });

  await service.syncGlobalPetPushToTalk();
  await Promise.resolve();

  assert.deepEqual(calls, ["warmup", "start"]);
});

test("pet service: repeated global ptt sync reuses in-flight native warmup", async () => {
  const calls: string[] = [];
  let resolveWarmup!: () => void;
  const warmupPromise = new Promise<void>((resolve) => {
    resolveWarmup = resolve;
  });
  const service = createService({
    nativeAudioCapture: {
      isNativeSupported: () => true,
      warmup: async () => {
        calls.push("warmup");
        await warmupPromise;
      }
    }
  });

  await Promise.all([
    service.syncGlobalPetPushToTalk(),
    service.syncGlobalPetPushToTalk()
  ]);
  await Promise.resolve();

  assert.equal(calls.filter((entry) => entry === "warmup").length, 1);

  resolveWarmup();
  await warmupPromise;
});

test("pet service: global ptt prepare path primes native capture on modifier down", async () => {
  const calls: string[] = [];
  const service = createService({
    globalPtt: {
      start: async (input) => {
        calls.push("start");
        input.onPrepare?.();
      }
    },
    nativeAudioCapture: {
      isNativeSupported: () => true,
      warmup: async () => {
        calls.push("warmup");
      },
      prepare: async () => {
        calls.push("prepare");
      }
    }
  });

  await service.syncGlobalPetPushToTalk();
  await Promise.resolve();

  assert.deepEqual(calls, ["warmup", "start", "prepare"]);
});

test("pet service: transcribeAndSendFromPet returns message instead of throwing on chat failure", async () => {
  const service = createService() as PetService & {
    chatFromPet: (...args: any[]) => Promise<{ replyText: string }>;
  };

  service.chatFromPet = async () => {
    throw new Error("模型并发已达上限，请稍后重试。");
  };

  const result = await service.transcribeAndSendFromPet({
    pcm16Base64: Buffer.from([1, 2, 3, 4]).toString("base64"),
    sampleRate: 16_000
  });

  assert.deepEqual(result, {
    sent: false,
    text: "你好",
    metadata: undefined,
    message: "模型并发已达上限，请稍后重试。"
  });
});

test("pet service: realtime voice state forwards only voice-state to pet", () => {
  const service = createService() as PetService & {
    emittedPetEvents: Array<{ type: string; phase?: string; mode?: string }>;
    emitRealtimeVoiceEvent: (event: VoiceSessionEvent) => void;
  };

  service.emitRealtimeVoiceEvent({
    type: "state",
    state: {
      ...DEFAULT_CONFIG.realtimeVoice,
      sessionId: "voice-session",
      phase: "assistant-thinking",
      mode: "free",
      target: null,
      userTranscript: "",
      userTranscriptMetadata: null,
      assistantTranscript: "",
      lastInterruptReason: null,
      errorMessage: null,
      playback: {
        active: false,
        queueLength: 0,
        level: 0,
        currentText: ""
      },
      updatedAt: new Date().toISOString()
    },
    timestamp: new Date().toISOString()
  } as VoiceSessionEvent);

  assert.deepEqual(service.emittedPetEvents, [
    {
      type: "voice-state",
      phase: "assistant-thinking",
      mode: "free"
    }
  ]);
});
