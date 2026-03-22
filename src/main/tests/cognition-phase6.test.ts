import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import type { CognitionConfig, MemoryNode } from "@shared/cognition";
import { DEFAULT_COGNITION_CONFIG } from "@shared/cognition";
import { CompanionPaths } from "../storage/paths.js";
import { loadCognitionConfig } from "../cognition/config.js";
import { MemoryGraphStore } from "../cognition/graph/memory-graph.js";
import { PoissonHeartbeat } from "../cognition/loop/heartbeat.js";
import { ColdArchive } from "../cognition/consolidation/cold-archive.js";
import { signalToSeeds } from "../cognition/loop/signal-to-seed.js";
import { GistExtractor } from "../cognition/consolidation/gist-extraction.js";
import { SleepReplay } from "../cognition/consolidation/sleep-replay.js";
import { ConsolidationEngine } from "../cognition/consolidation/consolidation-engine.js";

async function createTempPaths(prefix: string): Promise<CompanionPaths> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const paths = new CompanionPaths(baseDir);
  paths.ensureLayout();
  return paths;
}

async function cleanupPaths(paths: CompanionPaths): Promise<void> {
  await fs.rm(paths.baseDir, { recursive: true, force: true });
}

function makeNode(input: Partial<MemoryNode> & Pick<MemoryNode, "content" | "type" | "embedding">): MemoryNode {
  const now = input.created_at ?? Date.now();
  return {
    id: input.id ?? randomUUID(),
    content: input.content,
    type: input.type,
    embedding: input.embedding,
    activation_level: input.activation_level ?? 0,
    activation_history: input.activation_history ?? [],
    base_level_activation: input.base_level_activation ?? Number.NEGATIVE_INFINITY,
    emotional_valence: input.emotional_valence ?? 0,
    created_at: now,
    last_activated_at: input.last_activated_at ?? now,
    source_time_range: input.source_time_range,
    source_node_count: input.source_node_count,
    consolidation_count: input.consolidation_count,
    last_consolidated_at: input.last_consolidated_at,
    metadata: input.metadata ?? {}
  };
}

function createConfig(overrides?: Partial<CognitionConfig>): CognitionConfig {
  return {
    ...DEFAULT_COGNITION_CONFIG,
    ...overrides,
    graph_maintenance: {
      ...DEFAULT_COGNITION_CONFIG.graph_maintenance,
      ...(overrides?.graph_maintenance ?? {})
    },
    consolidation: {
      ...DEFAULT_COGNITION_CONFIG.consolidation,
      ...(overrides?.consolidation ?? {})
    },
    loop: {
      ...DEFAULT_COGNITION_CONFIG.loop,
      ...(overrides?.loop ?? {}),
      active_hours: {
        ...DEFAULT_COGNITION_CONFIG.loop.active_hours,
        ...(overrides?.loop?.active_hours ?? {})
      }
    }
  };
}

test("phase-six config bootstraps consolidation defaults", async () => {
  const paths = await createTempPaths("yobi-cognition-phase6-config-");
  try {
    const loaded = await loadCognitionConfig(paths);
    assert.equal(loaded.consolidation.enabled, true);
    assert.equal(loaded.consolidation.hot_node_limit, 8000);
    assert.equal(loaded.consolidation.replay_hebbian_rate, 0.03);
    assert.equal(loaded.consolidation.cluster_similarity_threshold, 0.75);
    assert.equal(loaded.consolidation.cold_recall_months_lookback, 3);
  } finally {
    await cleanupPaths(paths);
  }
});

test("PoissonHeartbeat supports pause and resume without losing schedule state", async () => {
  const heartbeat = new PoissonHeartbeat({
    ...DEFAULT_COGNITION_CONFIG.loop,
    heartbeat_lambda_minutes: 0.01,
    min_interval_minutes: 0.01,
    max_interval_minutes: 0.01,
    active_hours: {
      start: 0,
      end: 23
    }
  }, async () => {});

  heartbeat.start();
  assert.ok(heartbeat.getNextScheduledTime() !== null);
  heartbeat.pause();
  assert.equal(heartbeat.getNextScheduledTime(), null);
  heartbeat.resume();
  assert.ok(heartbeat.getNextScheduledTime() !== null);
  heartbeat.stop();
});

test("ColdArchive migrates nodes and signalToSeeds consumes pending cold recall on next tick", async () => {
  const paths = await createTempPaths("yobi-cognition-phase6-cold-archive-");
  try {
    const config = createConfig();
    const graph = new MemoryGraphStore(paths, config.graph_maintenance);
    const archived = makeNode({
      id: "cold-node",
      content: "周末露营计划",
      type: "event",
      embedding: [1, 0, 0],
      activation_history: [Date.now() - 20_000],
      created_at: Date.now() - 20_000,
      last_activated_at: Date.now() - 20_000
    });
    graph.addNode(archived);

    const coldArchive = new ColdArchive({
      paths,
      logger: { warn() {} } as never,
      getCognitionConfig: () => config
    });
    const migration = await coldArchive.migrateNodes({
      candidateIds: ["cold-node"],
      graph,
      startIndex: 0,
      checkpointInterval: 50
    });
    assert.equal(migration.migratedCount, 1);
    assert.equal(graph.getNode("cold-node"), undefined);

    coldArchive.requestAsyncRecall([1, 0, 0]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const seeds = await signalToSeeds(
      {
        type: "time_signal",
        payload: {
          hour: 10,
          weekday: "Monday",
          date: "2026-03-22"
        }
      },
      graph,
      async () => [1, 0, 0],
      {
        actr: config.actr,
        nowMs: Date.now(),
        coldArchive
      }
    );

    assert.equal(graph.getNode("cold-node")?.content, "周末露营计划");
    assert.ok(seeds.some((seed) => seed.nodeId === "cold-node" && seed.energy >= 0.7));
  } finally {
    await cleanupPaths(paths);
  }
});

test("GistExtractor creates abstract_summary nodes with abstracts and related_to edges", async () => {
  const paths = await createTempPaths("yobi-cognition-phase6-gist-");
  try {
    const config = createConfig();
    const graph = new MemoryGraphStore(paths, config.graph_maintenance);
    const createdAt = Date.now() - 10_000;
    const eventIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const node = makeNode({
        id: `event-${index}`,
        content: `晚餐讨论 ${index}`,
        type: "event",
        embedding: index === 0
          ? [1, 0, 0]
          : index === 1
            ? [0.82, 0.57, 0]
            : [0.82, 0, 0.57],
        activation_history: [createdAt + index],
        base_level_activation: 0.5 + index * 0.1,
        created_at: createdAt + index,
        last_activated_at: createdAt + index
      });
      graph.addNode(node);
      eventIds.push(node.id);
    }
    graph.addNode(makeNode({
      id: "neighbor",
      content: "料理偏好",
      type: "fact",
      embedding: [0, 1, 0]
    }));
    graph.addEdge({
      id: "event-neighbor",
      source: "event-0",
      target: "neighbor",
      relation_type: "semantic",
      weight: 0.7,
      created_at: createdAt,
      last_activated_at: createdAt
    });

    const extractor = new GistExtractor({
      graph,
      getCognitionConfig: () => config,
      summarizeCluster: async () => "最近几次都在聊晚餐安排"
    });
    const report = await extractor.extractAbstractions({
      start: createdAt - 1000,
      end: Date.now()
    });

    assert.equal(report.abstractNodesCreated, 1);
    const abstractNode = graph.getAllNodes().find((node) => node.content === "最近几次都在聊晚餐安排");
    assert.ok(abstractNode);
    assert.equal(abstractNode?.source_node_count, 3);
    assert.ok(abstractNode?.source_time_range?.earliest);
    assert.equal(graph.getEdgesBetween(abstractNode!.id, "event-0")[0]?.relation_type, "abstracts");
    assert.equal(graph.getEdgesBetween(abstractNode!.id, "neighbor")[0]?.relation_type, "related_to");
  } finally {
    await cleanupPaths(paths);
  }
});

test("ConsolidationEngine replays, extracts gist, archives low-value nodes, and excludes abstract-referenced nodes from forgetting", async () => {
  const paths = await createTempPaths("yobi-cognition-phase6-engine-");
  try {
    const now = Date.now();
    const config = createConfig({
      consolidation: {
        ...DEFAULT_COGNITION_CONFIG.consolidation,
        enabled: true,
        hot_node_limit: 999_999
      }
    });
    const graph = new MemoryGraphStore(paths, config.graph_maintenance);

    graph.addNode(makeNode({
      id: "hub-a",
      content: "工作总结",
      type: "concept",
      embedding: [1, 0, 0],
      activation_history: [now - 5_000, now - 4_000],
      base_level_activation: 1.2,
      created_at: now - 5_000,
      last_activated_at: now - 4_000,
      metadata: { reinforcement_count: 2 }
    }));
    graph.addNode(makeNode({
      id: "hub-b",
      content: "项目进展",
      type: "fact",
      embedding: [0.78, 0.62, 0],
      activation_history: [now - 5_000, now - 3_000],
      base_level_activation: 1.1,
      created_at: now - 5_000,
      last_activated_at: now - 3_000,
      metadata: { reinforcement_count: 1 }
    }));
    graph.addEdge({
      id: "hub-a-b",
      source: "hub-a",
      target: "hub-b",
      relation_type: "semantic",
      weight: 0.2,
      created_at: now - 4_000,
      last_activated_at: now - 4_000
    });

    graph.addNode(makeNode({
      id: "old-forget",
      content: "过期零碎事件",
      type: "event",
      embedding: [0, 1, 0],
      activation_history: [now - 10 * 24 * 3_600_000],
      base_level_activation: -4,
      created_at: now - 10 * 24 * 3_600_000,
      last_activated_at: now - 10 * 24 * 3_600_000
    }));
    graph.addNode(makeNode({
      id: "old-keep",
      content: "被摘要引用的旧事件",
      type: "event",
      embedding: [0, 0, 1],
      activation_history: [now - 10 * 24 * 3_600_000],
      base_level_activation: -4,
      created_at: now - 10 * 24 * 3_600_000,
      last_activated_at: now - 10 * 24 * 3_600_000
    }));
    graph.addNode(makeNode({
      id: "existing-abstract",
      content: "旧摘要",
      type: "abstract_summary",
      embedding: [0.82, 0.1, 0.56],
      activation_history: [now - 2_000],
      base_level_activation: 0.8,
      created_at: now - 2_000,
      last_activated_at: now - 2_000,
      source_node_count: 1,
      source_time_range: {
        earliest: new Date(now - 10 * 24 * 3_600_000).toISOString(),
        latest: new Date(now - 10 * 24 * 3_600_000).toISOString()
      }
    }));
    graph.addEdge({
      id: "existing-abstract-edge",
      source: "existing-abstract",
      target: "old-keep",
      relation_type: "abstracts",
      weight: 0.8,
      created_at: now - 2_000,
      last_activated_at: now - 2_000
    });

    for (let index = 0; index < 3; index += 1) {
      graph.addNode(makeNode({
        id: `fresh-event-${index}`,
        content: `今天又聊到旅行计划 ${index}`,
        type: "event",
        embedding: index === 0
          ? [1, 0, 0]
          : index === 1
            ? [0.82, 0.57, 0]
            : [0.82, 0, 0.57],
        activation_history: [now - 1_000 + index],
        base_level_activation: 0.7,
        created_at: now - 1_000 + index,
        last_activated_at: now - 1_000 + index
      }));
    }

    const coldArchive = new ColdArchive({
      paths,
      logger: { warn() {} } as never,
      getCognitionConfig: () => config
    });
    const sleepReplay = new SleepReplay({
      graph,
      getCognitionConfig: () => config
    });
    const gistExtractor = new GistExtractor({
      graph,
      getCognitionConfig: () => config,
      summarizeCluster: async () => "最近反复在规划旅行安排"
    });
    const engine = new ConsolidationEngine({
      paths,
      graph,
      sleepReplay,
      gistExtractor,
      coldArchive,
      logger: { warn() {} } as never,
      getCognitionConfig: () => config,
      getUserActivityState: () => ({
        online: false,
        last_active: now - 3 * 3_600_000
      })
    });
    await engine.load();

    const report = await engine.runConsolidation("manual");
    assert.equal(report.trigger, "manual");
    assert.ok((graph.getNode("hub-a")?.consolidation_count ?? 0) >= 1);
    assert.equal(graph.getNode("old-forget"), undefined);
    assert.ok(graph.getNode("old-keep"));
    assert.ok(report.archive_report.excludedByAbstraction >= 1);
    assert.ok(report.gist_report.abstractNodesCreated >= 1);

    const stats = await coldArchive.getArchiveStats();
    assert.ok(stats.totalNodes >= 1);
    const latest = await engine.getLastReport();
    assert.equal(latest?.trigger, "manual");
  } finally {
    await cleanupPaths(paths);
  }
});
