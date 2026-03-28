import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { NativeAudioCaptureService } from "@main/services/native-audio-capture";

class FakeWritable {
  private readonly chunks: string[] = [];

  write(chunk: Buffer | string): boolean {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    return true;
  }

  readLines(): string[] {
    return this.chunks
      .join("")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }
}

class FakeReadable extends EventEmitter {
  setEncoding(): this {
    return this;
  }

  pushLine(line: Record<string, unknown>): void {
    this.emit("data", `${JSON.stringify(line)}\n`);
  }
}

class FakeChildProcess extends EventEmitter {
  readonly stdin = new FakeWritable();
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.emit("close", 0);
    return true;
  }
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createService(child: FakeChildProcess, keepAliveMs = 1): NativeAudioCaptureService {
  return new NativeAudioCaptureService({
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    } as never,
    keepAliveMs,
    resolveHelperPath: async () => "/tmp/yobi-native-audio",
    spawnProcess: () => child as never,
    platform: "darwin"
  });
}

test("native audio capture: startSegment opens helper and stopSegment returns captured pcm", async () => {
  const child = new FakeChildProcess();
  const service = createService(child);

  const startPromise = service.startSegment();
  await flushMicrotasks();

  assert.deepEqual(child.stdin.readLines(), []);

  child.stdout.pushLine({
    type: "ready"
  });
  await flushMicrotasks();
  assert.deepEqual(
    child.stdin.readLines().map((line) => JSON.parse(line).command),
    ["ensure_open"]
  );
  child.stdout.pushLine({
    type: "opened"
  });
  await startPromise;

  await flushMicrotasks();
  assert.deepEqual(
    child.stdin.readLines().map((line) => JSON.parse(line).command),
    ["ensure_open", "start_segment"]
  );

  const stopPromise = service.stopSegment();
  await flushMicrotasks();
  assert.deepEqual(
    child.stdin.readLines().map((line) => JSON.parse(line).command),
    ["ensure_open", "start_segment", "stop_segment"]
  );

  child.stdout.pushLine({
    type: "segment_result",
    pcm16Base64: "AQID",
    durationMs: 320,
    sampleRate: 16_000
  });

  const captured = await stopPromise;
  assert.equal(captured.pcm16Base64, "AQID");
  assert.equal(captured.durationMs, 320);
  assert.equal(captured.sampleRate, 16_000);

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    child.stdin.readLines().map((line) => JSON.parse(line).command).at(-1),
    "close"
  );

  await service.stop();
});

test("native audio capture: warmup keeps helper alive and idle close does not respawn it", async () => {
  const child = new FakeChildProcess();
  const service = createService(child);

  const warmupPromise = service.warmup();
  await flushMicrotasks();
  child.stdout.pushLine({
    type: "ready"
  });
  await warmupPromise;

  assert.deepEqual(child.stdin.readLines(), []);

  const firstStartPromise = service.startSegment();
  await flushMicrotasks();
  child.stdout.pushLine({
    type: "opened"
  });
  await firstStartPromise;

  const firstStopPromise = service.stopSegment();
  await flushMicrotasks();
  child.stdout.pushLine({
    type: "segment_result",
    pcm16Base64: "AQID",
    durationMs: 320,
    sampleRate: 16_000
  });
  await firstStopPromise;

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    child.stdin.readLines().map((line) => JSON.parse(line).command).at(-1),
    "close"
  );

  child.stdout.pushLine({
    type: "closed"
  });
  await flushMicrotasks();

  const secondStartPromise = service.startSegment();
  await flushMicrotasks();
  child.stdout.pushLine({
    type: "opened"
  });
  await secondStartPromise;

  assert.deepEqual(
    child.stdin.readLines().map((line) => JSON.parse(line).command),
    ["ensure_open", "start_segment", "stop_segment", "close", "ensure_open", "start_segment"]
  );

  await service.stop();
});

test("native audio capture: prepare opens microphone without starting capture", async () => {
  const child = new FakeChildProcess();
  const service = createService(child);

  const preparePromise = service.prepare();
  await flushMicrotasks();
  child.stdout.pushLine({
    type: "ready"
  });
  await flushMicrotasks();
  child.stdout.pushLine({
    type: "opened"
  });
  await preparePromise;

  assert.deepEqual(
    child.stdin.readLines().map((line) => JSON.parse(line).command),
    ["ensure_open"]
  );

  await service.stop();
});

test("native audio capture: stream mode forwards pcm frames and stops cleanly", async () => {
  const child = new FakeChildProcess();
  const service = createService(child);
  const frames: Array<{ byteLength: number; sampleRate: number }> = [];

  service.onPcmFrame((frame) => {
    frames.push({
      byteLength: frame.pcm.length,
      sampleRate: frame.sampleRate
    });
  });

  const startPromise = service.startStream();
  await flushMicrotasks();
  child.stdout.pushLine({
    type: "ready"
  });
  await flushMicrotasks();
  child.stdout.pushLine({
    type: "opened"
  });
  await startPromise;

  await flushMicrotasks();
  assert.deepEqual(
    child.stdin.readLines().map((line) => JSON.parse(line).command),
    ["ensure_open", "start_stream"]
  );

  child.stdout.pushLine({
    type: "pcm_frame",
    pcm16Base64: Buffer.from([1, 2, 3, 4]).toString("base64"),
    sampleRate: 16_000
  });
  await flushMicrotasks();

  assert.deepEqual(frames, [
    {
      byteLength: 4,
      sampleRate: 16_000
    }
  ]);

  await service.stopStream();
  await flushMicrotasks();

  assert.equal(
    child.stdin.readLines().map((line) => JSON.parse(line).command).includes("stop_stream"),
    true
  );

  await service.stop();
});

test("native audio capture: concurrent startSegment calls only issue one helper start", async () => {
  const child = new FakeChildProcess();
  const service = createService(child);

  const firstStartPromise = service.startSegment();
  const secondStartPromise = service.startSegment();

  await flushMicrotasks();
  child.stdout.pushLine({
    type: "ready"
  });
  await flushMicrotasks();
  child.stdout.pushLine({
    type: "opened"
  });

  await Promise.all([firstStartPromise, secondStartPromise]);

  assert.deepEqual(
    child.stdin.readLines().map((line) => JSON.parse(line).command),
    ["ensure_open", "start_segment"]
  );

  await service.stop();
});

test("native audio capture: stopSegment waits for queued startSegment before stopping", async () => {
  const child = new FakeChildProcess();
  const service = createService(child);

  const startPromise = service.startSegment();
  const stopPromise = service.stopSegment();

  await flushMicrotasks();
  child.stdout.pushLine({
    type: "ready"
  });
  await flushMicrotasks();
  child.stdout.pushLine({
    type: "opened"
  });
  await flushMicrotasks();

  assert.deepEqual(
    child.stdin.readLines().map((line) => JSON.parse(line).command),
    ["ensure_open", "start_segment", "stop_segment"]
  );

  child.stdout.pushLine({
    type: "segment_result",
    pcm16Base64: "AQID",
    durationMs: 320,
    sampleRate: 16_000
  });

  await startPromise;
  const captured = await stopPromise;
  assert.equal(captured.pcm16Base64, "AQID");

  await service.stop();
});
