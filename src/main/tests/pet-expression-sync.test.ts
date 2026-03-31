import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "@shared/types";
import { PetService } from "@main/services/pet-service";

function createService(overrides?: {
  getConfig?: ConstructorParameters<typeof PetService>[0]["getConfig"];
  isPetOnline?: () => boolean;
  emitEvent?: (event: unknown) => void;
  open?: (input: unknown) => void;
}) {
  return new PetService({
    paths: {} as never,
    getConfig:
      overrides?.getConfig ??
      (() =>
        ({
          ...DEFAULT_CONFIG,
          pet: {
            ...DEFAULT_CONFIG.pet,
            enabled: true,
            modelDir: process.cwd(),
            expressionId: "Smile"
          }
        }) as never),
    pet: {
      isOnline: overrides?.isPetOnline ?? (() => true),
      emitEvent: overrides?.emitEvent ?? (() => undefined),
      open: overrides?.open ?? (() => undefined),
      close: () => undefined
    } as never,
    stateStore: {
      subscribe: () => undefined
    } as never,
    voiceRouter: {
      isAsrReady: () => true,
      transcribePcm16: async () => ({ text: "你好" })
    } as never,
    realtimeVoice: {
      onEvent: () => undefined,
      stop: () => undefined,
      start: () => undefined,
      isActive: () => false,
      handlePttPhase: async () => undefined
    } as never,
    globalPtt: {
      start: async () => undefined,
      stop: () => undefined
    } as never,
    systemPermissionsService: {
      ensureGlobalPttPermission: () => true
    } as never,
    channelRouter: {} as never,
    primaryResourceId: "primary-user",
    primaryThreadId: "primary-thread",
    chatReplyTimeoutMs: 1000,
    withTimeout: async <T>(promise: Promise<T>) => promise,
    onStatusChange: async () => undefined
  });
}

test("pet service: syncPetWindow replays saved expression after opening the pet window", () => {
  const emitted: unknown[] = [];
  let opened = false;
  const service = createService({
    open: () => {
      opened = true;
    },
    emitEvent: (event) => {
      emitted.push(event);
    }
  });

  service.syncPetWindow();

  assert.equal(opened, true);
  assert.deepEqual(
    emitted.find((event) => (event as { type?: string }).type === "expression"),
    {
      type: "expression",
      id: "Smile"
    }
  );
});

test("pet service: syncPetWindow resets expression when saved expression is empty", () => {
  const emitted: unknown[] = [];
  const service = createService({
    getConfig: () =>
      ({
        ...DEFAULT_CONFIG,
        pet: {
          ...DEFAULT_CONFIG.pet,
          enabled: true,
          modelDir: process.cwd(),
          expressionId: ""
        }
      }) as never,
    emitEvent: (event) => {
      emitted.push(event);
    }
  });

  service.syncPetWindow();

  assert.deepEqual(
    emitted.find((event) => (event as { type?: string }).type === "expression"),
    {
      type: "expression",
      id: ""
    }
  );
});
