import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, type VoiceSessionState } from "@shared/types";
import {
  CompanionModeService,
  computeCompanionFrameDiffRatio
} from "../services/companion-mode.js";
import type { FrontWindowCaptureFrame } from "../services/front-window-capture.js";

function createVoiceState(overrides?: Partial<VoiceSessionState>): VoiceSessionState {
  return {
    sessionId: null,
    phase: "idle",
    mode: "ptt",
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
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

function createService(overrides?: {
  permissions?: { microphone: "granted" | "denied" | "unknown"; screenCapture: "granted" | "denied" | "unknown" };
  getVoiceSessionState?: () => VoiceSessionState;
  startVoiceSession?: (input?: { mode?: "ptt" | "free" }) => Promise<VoiceSessionState>;
  captureFrontWindow?: () => Promise<FrontWindowCaptureFrame | null>;
  dispatchAutomationMessage?: (input: {
    text: string;
    frontWindow?: { appName: string; title: string; focused: boolean } | null;
    attachments?: Array<{ id: string }>;
  }) => Promise<boolean>;
}) {
  const startVoiceCalls: Array<{ mode?: "ptt" | "free" } | undefined> = [];
  const service = new CompanionModeService({
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    } as never,
    getConfig: () => DEFAULT_CONFIG,
    getSystemPermissions: () => ({
      accessibility: "granted",
      microphone: overrides?.permissions?.microphone ?? "granted",
      screenCapture: overrides?.permissions?.screenCapture ?? "granted"
    }),
    getVoiceSessionState: overrides?.getVoiceSessionState ?? (() => createVoiceState()),
    startVoiceSession:
      overrides?.startVoiceSession ??
      (async (input) => {
        startVoiceCalls.push(input);
        return createVoiceState({
          sessionId: "voice-session-1",
          phase: "listening",
          mode: "free"
        });
      }),
    stopVoiceSession: async () => ({ accepted: true }),
    dispatchAutomationMessage: overrides?.dispatchAutomationMessage ?? (async () => true),
    readActivitySnapshot: () => ({
      lastUserAt: null,
      lastProactiveAt: null,
      lastInboundChannel: null,
      lastInboundChatId: null,
      lastTelegramChatId: null,
      lastFeishuChatId: null,
      lastQQChatId: null
    }),
    getRecentHistory: async () => [],
    captureFrontWindow: overrides?.captureFrontWindow ?? (async () => null),
    setIntervalFn: (() => ({ unref: () => undefined })) as any,
    clearIntervalFn: () => undefined,
    onStatusChange: async () => undefined
  });

  return {
    service,
    startVoiceCalls
  };
}

test("computeCompanionFrameDiffRatio: identical frames produce zero diff", () => {
  const left = Buffer.from([
    0, 0, 0, 255,
    255, 255, 255, 255
  ]);
  const right = Buffer.from([
    0, 0, 0, 255,
    255, 255, 255, 255
  ]);

  assert.equal(computeCompanionFrameDiffRatio(left, right), 0);
});

test("computeCompanionFrameDiffRatio: tiny pixel changes stay below the local prefilter threshold", () => {
  const left = Buffer.from([
    100, 100, 100, 255,
    120, 120, 120, 255
  ]);
  const right = Buffer.from([
    101, 100, 100, 255,
    120, 120, 121, 255
  ]);

  assert.ok(computeCompanionFrameDiffRatio(left, right) < 0.015);
});

test("CompanionModeService: start refuses to activate without screen capture permission", async () => {
  const { service, startVoiceCalls } = createService({
    permissions: {
      microphone: "granted",
      screenCapture: "denied"
    }
  });

  const state = await service.start();

  assert.equal(state.active, false);
  assert.equal(state.availability, "screen-permission-required");
  assert.match(state.reason ?? "", /屏幕/i);
  assert.deepEqual(startVoiceCalls, []);
});

test("CompanionModeService: start auto-starts free voice when permissions are granted", async () => {
  const { service, startVoiceCalls } = createService();

  const state = await service.start();

  assert.equal(state.active, true);
  assert.equal(state.availability, "ready");
  assert.deepEqual(startVoiceCalls, [{ mode: "free" }]);
});

test("CompanionModeService: first idle sample establishes a baseline without dispatching automation", async () => {
  let dispatchCount = 0;
  const { service } = createService({
    captureFrontWindow: async () => ({
      frontWindow: {
        appName: "Safari",
        title: "Example",
        focused: true
      },
      diffBitmap: Buffer.from([
        0, 0, 0, 255,
        255, 255, 255, 255
      ]),
      diffSize: {
        width: 2,
        height: 1
      },
      modelImage: {
        buffer: Buffer.from("jpeg"),
        mimeType: "image/jpeg",
        filename: "companion-capture.jpg",
        width: 2,
        height: 1
      },
      storeAttachment: async () => ({
        id: "attachment-1",
        kind: "image",
        filename: "companion-capture.jpg",
        mimeType: "image/jpeg",
        size: 4,
        path: "/tmp/companion-capture.jpg",
        source: "companion-capture",
        createdAt: new Date().toISOString()
      })
    }),
    dispatchAutomationMessage: async () => {
      dispatchCount += 1;
      return true;
    }
  });

  await service.start();
  await (service as any).sampleIfIdle();

  assert.equal(service.getState().frontWindow?.appName, "Safari");
  assert.equal(dispatchCount, 0);
});

test("CompanionModeService: low-diff idle sample skips automation before any LLM call", async () => {
  let dispatchCount = 0;
  const frames: FrontWindowCaptureFrame[] = [
    {
      frontWindow: {
        appName: "Safari",
        title: "Example",
        focused: true
      },
      diffBitmap: Buffer.from([
        100, 100, 100, 255,
        120, 120, 120, 255
      ]),
      diffSize: {
        width: 2,
        height: 1
      },
      modelImage: {
        buffer: Buffer.from("jpeg-1"),
        mimeType: "image/jpeg",
        filename: "companion-capture.jpg",
        width: 2,
        height: 1
      },
      storeAttachment: async () => ({
        id: "attachment-1",
        kind: "image",
        filename: "companion-capture.jpg",
        mimeType: "image/jpeg",
        size: 6,
        path: "/tmp/companion-capture-1.jpg",
        source: "companion-capture",
        createdAt: new Date().toISOString()
      })
    },
    {
      frontWindow: {
        appName: "Safari",
        title: "Example",
        focused: true
      },
      diffBitmap: Buffer.from([
        101, 100, 100, 255,
        120, 120, 121, 255
      ]),
      diffSize: {
        width: 2,
        height: 1
      },
      modelImage: {
        buffer: Buffer.from("jpeg-2"),
        mimeType: "image/jpeg",
        filename: "companion-capture.jpg",
        width: 2,
        height: 1
      },
      storeAttachment: async () => ({
        id: "attachment-2",
        kind: "image",
        filename: "companion-capture.jpg",
        mimeType: "image/jpeg",
        size: 6,
        path: "/tmp/companion-capture-2.jpg",
        source: "companion-capture",
        createdAt: new Date().toISOString()
      })
    }
  ];
  const { service } = createService({
    captureFrontWindow: async () => frames.shift() ?? null,
    dispatchAutomationMessage: async () => {
      dispatchCount += 1;
      return true;
    }
  });

  await service.start();
  await (service as any).sampleIfIdle();
  await (service as any).sampleIfIdle();

  assert.equal(dispatchCount, 0);
});
