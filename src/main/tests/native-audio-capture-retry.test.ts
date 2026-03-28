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

  kill(): boolean {
    this.emit("close", 0);
    return true;
  }
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("native audio capture: helper close during open rejects and next start retries", async () => {
  const firstChild = new FakeChildProcess();
  const secondChild = new FakeChildProcess();
  const children = [firstChild, secondChild];
  let spawnCount = 0;

  const service = new NativeAudioCaptureService({
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    } as never,
    keepAliveMs: 1,
    resolveHelperPath: async () => "/tmp/yobi-native-audio",
    spawnProcess: () => children[spawnCount++] as never,
    platform: "darwin"
  });

  const firstStartPromise = service.startSegment();
  await flushMicrotasks();
  firstChild.emit("close", 0);
  await assert.rejects(firstStartPromise, /helper 已断开/);

  const secondStartPromise = service.startSegment();
  await flushMicrotasks();
  secondChild.stdout.pushLine({
    type: "ready"
  });
  await flushMicrotasks();
  secondChild.stdout.pushLine({
    type: "opened"
  });
  await secondStartPromise;

  assert.equal(spawnCount, 2);
  assert.deepEqual(
    secondChild.stdin.readLines().map((line) => JSON.parse(line).command),
    ["ensure_open", "start_segment"]
  );

  await service.stop();
});
