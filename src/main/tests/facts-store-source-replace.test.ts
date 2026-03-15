import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { CompanionPaths } from "../storage/paths.js";
import { FactsStore } from "../memory-v2/facts-store.js";

test("FactsStore.replaceBySource: should replace only managed source facts", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "yobi-browse-facts-"));
  let store: FactsStore | null = null;
  try {
    const paths = new CompanionPaths(baseDir);
    paths.ensureLayout();

    store = new FactsStore(paths);
    await store.applyOperations(
      [
        {
          action: "add",
          fact: {
            entity: "Yobi",
            key: "legacy.browse",
            value: "旧素材",
            category: "event",
            confidence: 0.7,
            ttl_class: "active",
            source: "browse:bilibili"
          }
        },
        {
          action: "add",
          fact: {
            entity: "用户",
            key: "other.fact",
            value: "保留内容",
            category: "event",
            confidence: 0.8,
            ttl_class: "active",
            source: "manual:test"
          }
        }
      ],
      "test"
    );

    await store.replaceBySource({
      source: "browse:bilibili",
      entity: "Yobi",
      facts: [
        {
          entity: "Yobi",
          key: "bilibili.preference.ups",
          value: "最近常看 UP：测试 A、测试 B",
          category: "preference",
          confidence: 0.8,
          ttl_class: "stable",
          source: "browse:bilibili"
        }
      ]
    });

    const facts = store.listActive();
    assert.equal(facts.some((fact) => fact.key === "legacy.browse"), false);
    assert.equal(facts.some((fact) => fact.key === "other.fact"), true);
    assert.equal(facts.some((fact) => fact.key === "bilibili.preference.ups"), true);
  } finally {
    await store?.close();
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});
