import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { CompanionPaths } from "../storage/paths.js";
import { StateStore } from "../kernel/state-store.js";
import {
  DEFAULT_OCEAN_PERSONALITY,
  createDefaultEmotionalState
} from "@shared/types";

async function createTempPaths(prefix: string): Promise<CompanionPaths> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const paths = new CompanionPaths(baseDir);
  paths.ensureLayout();
  return paths;
}

test("StateStore: legacy emotional shape is discarded and rebuilt with new defaults", async () => {
  const paths = await createTempPaths("yobi-state-migrate-");

  try {
    await fs.writeFile(
      paths.statePath,
      JSON.stringify(
        {
          emotional: {
            mood: 0.9,
            energy: 0.1,
            connection: 0.99,
            curiosity: 0.99,
            confidence: 0.99,
            irritation: 0.99
          },
          relationship: {
            stage: "close",
            upgradeStreak: 2,
            downgradeStreak: 1
          },
          updatedAt: new Date("2026-03-14T00:00:00.000Z").toISOString()
        },
        null,
        2
      ),
      "utf8"
    );

    const store = new StateStore(paths);
    await store.init();
    const snapshot = store.getSnapshot();

    assert.deepEqual(snapshot.emotional, createDefaultEmotionalState("close"));
    assert.deepEqual(snapshot.personality, DEFAULT_OCEAN_PERSONALITY);
    assert.deepEqual(snapshot.ruminationQueue, []);
    assert.equal(snapshot.relationship.stage, "close");
  } finally {
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});

test("StateStore: sessionWarmth remains in memory but is stripped from persisted state", async () => {
  const paths = await createTempPaths("yobi-state-session-warmth-");

  try {
    const store = new StateStore(paths);
    await store.init();

    store.mutate((state) => {
      state.emotional.sessionWarmth = 0.91;
    });
    await store.flushIfDirty();

    const persisted = JSON.parse(await fs.readFile(paths.statePath, "utf8")) as Record<string, any>;
    assert.equal(persisted.emotional.sessionWarmth, undefined);
    assert.equal(persisted.emotional.connection, 0.25);
    assert.deepEqual(store.getSnapshot().emotional.sessionWarmth, 0.91);
  } finally {
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});
