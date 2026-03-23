import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Fact } from "@shared/types";
import { DEFAULT_COGNITION_CONFIG, type CombinedDialogueExtractionDraft, type MemoryNode } from "@shared/cognition";
import { CompanionPaths } from "../storage/paths.js";
import { MemoryGraphStore } from "../cognition/graph/memory-graph.js";
import {
  FIXED_USER_PERSON_ID,
  FIXED_YOBI_PERSON_ID,
  applyCombinedExtraction,
  ensureFixedPersonNodes
} from "../cognition/ingestion/graph-adapter.js";

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
    base_level_activation: input.base_level_activation ?? 0,
    emotional_valence: input.emotional_valence ?? 0,
    created_at: now,
    last_activated_at: input.last_activated_at ?? now,
    metadata: input.metadata ?? {}
  };
}

function createFactFromOperation(
  operation: CombinedDialogueExtractionDraft["fact_operations"][number],
  source = "cognition-ingestion"
): Fact {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    entity: operation.fact.entity,
    key: operation.fact.key,
    value: operation.fact.value,
    category: operation.fact.category,
    confidence: operation.fact.confidence,
    source,
    created_at: now,
    updated_at: now,
    ttl_class: operation.fact.ttl_class,
    last_accessed_at: now,
    superseded_by: null,
    source_range: operation.fact.source_range
  };
}

test("applyCombinedExtraction maps placeholders, persists sentence facts, merges same-type nodes, and caps edge weights", async () => {
  const paths = await createTempPaths("yobi-cognition-ingestion-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    const embeddings = new Map<string, number[]>([
      ["用户", [1, 0, 0]],
      ["Yobi", [0, 1, 0]],
      ["用户喜欢热乎的拉面", [0.9, 0.1, 0]],
      ["用户", [1, 0, 0]]
    ]);
    const syncedFacts: Fact[][] = [];
    const appliedOperations: Array<CombinedDialogueExtractionDraft["fact_operations"]> = [];

    await ensureFixedPersonNodes({
      graph,
      embedText: async (text) => embeddings.get(text) ?? [0, 0, 1],
      nowMs: 1_000
    });

    graph.addNode(
      makeNode({
        id: "existing-fact",
        content: "用户喜欢热乎的拉面",
        type: "fact",
        embedding: [0.9, 0.1, 0],
        activation_history: [100, 200],
        metadata: {
          reinforcement_count: 2
        },
        created_at: 100
      })
    );
    graph.addEdge({
      id: "existing-edge",
      source: FIXED_USER_PERSON_ID,
      target: "existing-fact",
      relation_type: "semantic",
      weight: 0.98,
      created_at: 100,
      last_activated_at: 100
    });

    const draft: CombinedDialogueExtractionDraft = {
      facts: ["用户喜欢热乎的拉面"],
      fact_operations: [
        {
          action: "add",
          fact: {
            entity: "用户",
            key: "食物偏好",
            value: "热乎的拉面",
            category: "preference",
            confidence: 0.93,
            ttl_class: "stable"
          }
        }
      ],
      graph: {
        nodes: [
          {
            content: "{{user}}",
            type: "person",
            emotional_valence: 0
          },
          {
            content: "{{user}}喜欢热乎的拉面",
            type: "fact",
            emotional_valence: 0.7
          }
        ],
        edges: [
          {
            source_content: "{{user}}",
            target_content: "{{user}}喜欢热乎的拉面",
            type: "semantic"
          }
        ],
        entity_merges: []
      }
    };

    await applyCombinedExtraction({
      paths,
      graph,
      channel: "console",
      draft,
      nowMs: 2_000,
      memory: {
        embedText: async (text) => embeddings.get(text) ?? [0, 0, 1],
        getFactsStore: () => ({
          applyOperations: async (operations: CombinedDialogueExtractionDraft["fact_operations"], _source?: string) => {
            appliedOperations.push(operations);
            return operations.map((operation) => createFactFromOperation(operation));
          }
        } as any),
        syncFactEmbeddings: async (facts: Fact[]) => {
          syncedFacts.push(facts);
        }
      }
    });

    const factNodes = graph.getAllNodes().filter((node) => node.type === "fact");
    assert.equal(factNodes.length, 1);
    assert.equal(factNodes[0]?.id, "existing-fact");

    const userNode = graph.getNode(FIXED_USER_PERSON_ID);
    assert.equal(userNode?.content, "用户");
    const yobiNode = graph.getNode(FIXED_YOBI_PERSON_ID);
    assert.equal(yobiNode?.content, "Yobi");

    const edges = graph.getEdgesBetween(FIXED_USER_PERSON_ID, "existing-fact");
    assert.equal(edges.length, 1);
    assert.equal(edges[0]?.weight, 1);

    assert.equal(appliedOperations.length, 1);
    assert.equal(appliedOperations[0]?.length, 1);
    assert.equal(syncedFacts.length, 1);
    assert.equal(syncedFacts[0]?.length, 1);

    const legacyFacts = JSON.parse(await fs.readFile(paths.factsPath, "utf8")) as string[];
    assert.deepEqual(legacyFacts, ["用户喜欢热乎的拉面"]);
  } finally {
    await cleanupPaths(paths);
  }
});

test("applyCombinedExtraction executes explicit entity merges for person nodes and preserves aliases", async () => {
  const paths = await createTempPaths("yobi-cognition-entity-merge-");
  try {
    const graph = new MemoryGraphStore(paths, DEFAULT_COGNITION_CONFIG.graph_maintenance);
    const embeddings = new Map<string, number[]>([
      ["用户", [1, 0, 0]],
      ["Yobi", [0, 1, 0]],
      ["小王", [0, 0, 1]],
      ["王哥", [0, 0, 0.95]],
      ["小王最近换了工作", [0.2, 0.7, 0.1]]
    ]);

    await ensureFixedPersonNodes({
      graph,
      embedText: async (text) => embeddings.get(text) ?? [0.1, 0.1, 0.1],
      nowMs: 1_000
    });

    const draft: CombinedDialogueExtractionDraft = {
      facts: [],
      fact_operations: [],
      graph: {
        nodes: [
          {
            content: "小王",
            type: "person",
            emotional_valence: 0
          },
          {
            content: "王哥",
            type: "person",
            emotional_valence: 0
          },
          {
            content: "小王最近换了工作",
            type: "fact",
            emotional_valence: 0.1
          }
        ],
        edges: [
          {
            source_content: "小王",
            target_content: "小王最近换了工作",
            type: "causal"
          },
          {
            source_content: "王哥",
            target_content: "小王最近换了工作",
            type: "semantic"
          }
        ],
        entity_merges: [
          {
            source_content: "王哥",
            target_content: "小王"
          }
        ]
      }
    };

    await applyCombinedExtraction({
      paths,
      graph,
      channel: "console",
      draft,
      nowMs: 2_000,
      memory: {
        embedText: async (text) => embeddings.get(text) ?? [0.1, 0.1, 0.1],
        getFactsStore: () => ({
          applyOperations: async () => []
        } as any),
        syncFactEmbeddings: async () => undefined
      }
    });

    const personNodes = graph.getAllNodes().filter((node) => node.type === "person");
    const mergedTarget = personNodes.find((node) => node.content === "小王");
    assert.ok(mergedTarget);
    assert.equal(personNodes.some((node) => node.content === "王哥"), false);
    assert.deepEqual(mergedTarget?.metadata.aliases, ["王哥"]);

    const mergedEdges = graph.getOutgoingEdges(mergedTarget!.id);
    assert.equal(mergedEdges.length, 2);
    assert.equal(mergedEdges.every((edge) => edge.source === mergedTarget?.id), true);
  } finally {
    await cleanupPaths(paths);
  }
});
