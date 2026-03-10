import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { CompanionPaths } from "../storage/paths.js";
import { YobiMemory } from "../memory/setup.js";
import { DEFAULT_CONFIG, type AppConfig } from "@shared/types";

function cloneConfig(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

test("searchRelevantFacts: hybrid vector recall can bridge 疲劳语义到加班 fact", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "yobi-embed-"));
  try {
    const paths = new CompanionPaths(baseDir);
    paths.ensureLayout();

    const config = cloneConfig();
    config.memory.embedding.enabled = true;
    config.memory.embedding.modelId = "test-model-v1";

    const memory = new YobiMemory(paths, () => config);
    await memory.init();

    const changed = await memory.getFactsStore().applyOperations(
      [
        {
          action: "add",
          fact: {
            entity: "用户",
            key: "工作状态",
            value: "最近加班较多",
            category: "event",
            confidence: 0.85,
            ttl_class: "active"
          }
        }
      ],
      "test"
    );

    await memory.getFactEmbeddingStore().upsert([
      {
        fact_id: changed[0]!.id,
        model_id: "test-model-v1",
        vector: [1, 0],
        updated_at: new Date().toISOString()
      }
    ]);
    await memory.getFactEmbeddingStore().flushIfDirty();

    (memory as any).embedder = {
      init() {},
      getCurrentModelId: () => "test-model-v1",
      getStatus: () => ({ status: "ready", mode: "vector-only", downloadPending: false, message: "test" }),
      embed: async () => ({ modelId: "test-model-v1", vector: [1, 0] })
    };

    const results = await memory.searchRelevantFacts({
      queryTexts: ["我今天真的好累"],
      facts: await memory.listFacts(),
      limit: 5
    });

    assert.equal(results[0]?.fact.value, "最近加班较多");
    assert.equal(results[0]?.semanticHit, true);
    assert.ok((results[0]?.vectorScore ?? 0) > 0);
    assert.ok((results[0]?.finalScore ?? 0) > 0);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test("searchRelevantFacts: modelId 切换后旧向量视为 stale", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "yobi-embed-stale-"));
  try {
    const paths = new CompanionPaths(baseDir);
    paths.ensureLayout();

    const config = cloneConfig();
    config.memory.embedding.enabled = true;
    config.memory.embedding.modelId = "test-model-v1";

    const memory = new YobiMemory(paths, () => config);
    await memory.init();

    const changed = await memory.getFactsStore().applyOperations(
      [
        {
          action: "add",
          fact: {
            entity: "用户",
            key: "工作状态",
            value: "最近加班较多",
            category: "event",
            confidence: 0.85,
            ttl_class: "active"
          }
        }
      ],
      "test"
    );

    await memory.getFactEmbeddingStore().upsert([
      {
        fact_id: changed[0]!.id,
        model_id: "test-model-v1",
        vector: [1, 0],
        updated_at: new Date().toISOString()
      }
    ]);
    await memory.getFactEmbeddingStore().flushIfDirty();

    config.memory.embedding.modelId = "test-model-v2";
    (memory as any).embedder = {
      init() {},
      getCurrentModelId: () => "test-model-v2",
      getStatus: () => ({ status: "ready", mode: "vector-only", downloadPending: false, message: "test" }),
      embed: async () => ({ modelId: "test-model-v2", vector: [1, 0] })
    };

    const results = await memory.searchRelevantFacts({
      queryTexts: ["我今天真的好累"],
      facts: await memory.listFacts(),
      limit: 5
    });

    assert.equal(results.length, 0);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});
