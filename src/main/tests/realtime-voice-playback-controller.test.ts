import test from "node:test";
import assert from "node:assert/strict";
import {
  RealtimeVoicePlaybackController,
  type RealtimeVoicePlaybackBridge,
  type RealtimeVoicePlaybackControllerEvent
} from "../services/realtime-voice-playback-controller.js";

function createBridgeHarness() {
  let listener: ((event: any) => void) | null = null;
  const enqueued: Array<{ chunkId: string; text: string; generation: number }> = [];
  const cleared: Array<{ generation: number; reason?: string }> = [];

  const bridge: RealtimeVoicePlaybackBridge = {
    enqueueSpeech: async (input) => {
      enqueued.push({
        chunkId: input.chunkId,
        text: input.text,
        generation: input.generation
      });
      return true;
    },
    clearSpeech: async (input) => {
      cleared.push(input);
      return true;
    },
    onVoiceEvent: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    }
  };

  return {
    bridge,
    enqueued,
    cleared,
    emit(event: any) {
      listener?.(event);
    }
  };
}

function collectEvents(
  controller: RealtimeVoicePlaybackController
): RealtimeVoicePlaybackControllerEvent[] {
  const events: RealtimeVoicePlaybackControllerEvent[] = [];
  controller.onEvent((event) => {
    events.push(event);
  });
  return events;
}

test("realtime voice playback controller: dispatches one chunk at a time", async () => {
  const harness = createBridgeHarness();
  const controller = new RealtimeVoicePlaybackController({
    bridge: harness.bridge,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    } as never
  });
  const events = collectEvents(controller);
  const generation = controller.beginGeneration();

  await controller.enqueue({
    chunkId: "chunk-1",
    text: "第一句",
    audioBase64: "YQ==",
    mimeType: "audio/mpeg",
    generation
  });
  await controller.enqueue({
    chunkId: "chunk-2",
    text: "第二句",
    audioBase64: "Yg==",
    mimeType: "audio/mpeg",
    generation
  });

  assert.deepEqual(harness.enqueued.map((item) => item.chunkId), ["chunk-1"]);

  await controller.handleBridgeEvent({
    type: "speech-playback-started",
    chunkId: "chunk-1",
    text: "第一句",
    generation
  });
  await controller.handleBridgeEvent({
    type: "speech-playback-ended",
    chunkId: "chunk-1",
    text: "第一句",
    generation
  });

  assert.deepEqual(harness.enqueued.map((item) => item.chunkId), ["chunk-1", "chunk-2"]);
  assert.equal(events.some((event) => event.type === "chunk-dispatched"), true);
  assert.equal(events.some((event) => event.type === "chunk-started"), true);
  assert.equal(events.some((event) => event.type === "chunk-ended"), true);
});

test("realtime voice playback controller: emits a start-timeout when playback ack never arrives", async () => {
  const harness = createBridgeHarness();
  const controller = new RealtimeVoicePlaybackController({
    bridge: harness.bridge,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    } as never,
    startTimeoutMs: 25
  });
  const events = collectEvents(controller);
  const generation = controller.beginGeneration();

  await controller.enqueue({
    chunkId: "chunk-timeout",
    text: "卡住了",
    audioBase64: "YQ==",
    mimeType: "audio/mpeg",
    generation
  });
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal(events.some((event) => event.type === "start-timeout"), true);
});

test("realtime voice playback controller: reference frames promote playback to started when started ack is missed", async () => {
  const harness = createBridgeHarness();
  const controller = new RealtimeVoicePlaybackController({
    bridge: harness.bridge,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    } as never,
    startTimeoutMs: 25
  });
  const events = collectEvents(controller);
  const generation = controller.beginGeneration();

  await controller.enqueue({
    chunkId: "chunk-ref",
    text: "第一句",
    audioBase64: "YQ==",
    mimeType: "audio/mpeg",
    generation
  });

  await controller.handleBridgeEvent({
    type: "speech-reference-frame",
    pcm: [0, 0, 0, 0],
    sampleRate: 16_000,
    generation
  });
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal(events.some((event) => event.type === "chunk-started"), true);
  assert.equal(events.some((event) => event.type === "start-timeout"), false);
});
