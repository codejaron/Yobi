import { randomUUID } from "node:crypto";
import { generateObject } from "ai";
import { z } from "zod";
import type { AppConfig } from "@shared/types";
import {
  memoryEdgeRelationSchema,
  memoryNodeTypeSchema,
  type ActivationLogEntry,
  type CognitionConfig,
  type CognitionConfigPatch,
  type CognitionDebugSnapshot,
  type HealthMetrics,
  type MemoryEdge,
  type MemoryNode
} from "@shared/cognition";
import { readJsonlFile } from "@main/storage/fs";
import type { CompanionPaths } from "@main/storage/paths";
import type { YobiMemory } from "@main/memory/setup";
import type { ConversationEngine } from "@main/core/conversation";
import { ModelFactory } from "@main/core/model-factory";
import { resolveOpenAIStoreOption } from "@main/core/provider-utils";
import type { AppLogger } from "@main/services/logger";
import { patchCognitionConfig, loadCognitionConfig } from "./config";
import { MemoryGraphStore } from "./graph/memory-graph";
import { ThoughtPool } from "./thoughts/thought-bubble";
import { SubconsciousLoop } from "./loop/subconscious-loop";

const dialogueExtractionSchema = z.object({
  nodes: z.array(
    z.object({
      content: z.string().min(1),
      type: memoryNodeTypeSchema,
      emotional_valence: z.number().min(-1).max(1).optional()
    }).strict()
  ).default([]),
  edges: z.array(
    z.object({
      source_content: z.string().min(1),
      target_content: z.string().min(1),
      relation_type: memoryEdgeRelationSchema,
      weight: z.number().min(0).max(1).optional()
    }).strict()
  ).default([])
}).strict();

interface CognitionEngineInput {
  paths: CompanionPaths;
  getConfig: () => AppConfig;
  memory: Pick<YobiMemory, "embedText" | "getProfile" | "listHistoryByCursor">;
  conversation: ConversationEngine;
  logger: AppLogger;
  getUserOnline?: () => boolean;
  getUserActivityState?: () => { online: boolean; last_active: number | null };
  onProactiveMessage?: (input: {
    message: string;
    metadata?: {
      proactive?: boolean;
      source?: string;
    };
    pushTargets?: {
      telegram: boolean;
      feishu: boolean;
    };
    recordProactive?: boolean;
  }) => Promise<void> | void;
  onTickCompleted?: (entry: ActivationLogEntry) => Promise<void> | void;
}

interface DialogueIngestInput {
  channel: string;
  assistantText: string;
  userText?: string;
  chatId?: string;
}

export class CognitionEngine {
  private static readonly EMBEDDING_PROBE_TEXT = "认知图 embedding probe";

  private readonly modelFactory: ModelFactory;
  private cognitionConfig: CognitionConfig | null = null;
  private graph: MemoryGraphStore | null = null;
  private thoughtPool: ThoughtPool | null = null;
  private loop: SubconsciousLoop | null = null;
  private lastExpressionTime = 0;
  private initialized = false;
  private embeddingRepairPromise: Promise<void> | null = null;
  private recentDialogueResidue: string[] = [];
  private lastDialogueTime: number | null = null;

  constructor(private readonly input: CognitionEngineInput) {
    this.modelFactory = new ModelFactory(() => this.input.getConfig());
  }

  async start(): Promise<void> {
    await this.ensureInitialized();
    this.loop?.start();
  }

  async stop(): Promise<void> {
    this.loop?.stop();
    this.graph?.serialize();
  }

  async ingestDialogue(input: DialogueIngestInput): Promise<void> {
    await this.ensureInitialized();
    const normalizedAssistant = input.assistantText.trim();
    const normalizedUser = input.userText?.trim() ?? "";
    if (!normalizedAssistant && !normalizedUser) {
      return;
    }

    const appConfig = this.input.getConfig();
    const result = await generateObject({
      model: this.modelFactory.getCognitionModel(),
      providerOptions: resolveOpenAIStoreOption(appConfig, "cognition"),
      schema: dialogueExtractionSchema,
      prompt: [
        "请从以下对话中提取实体和关系，返回 JSON 格式 {nodes: [{content, type, emotional_valence?}], edges: [{source_content, target_content, relation_type, weight?}]}。",
        "只返回结构化 JSON，不要解释。",
        JSON.stringify(
          {
            channel: input.channel,
            chat_id: input.chatId ?? null,
            user: normalizedUser,
            assistant: normalizedAssistant,
            now_iso: new Date().toISOString()
          },
          null,
          2
        )
      ].join("\n")
    });

    const parsed = dialogueExtractionSchema.parse(result.object ?? {});
    const graph = this.requireGraph();
    const now = Date.now();
    const contentToId = new Map<string, string>();

    for (const draft of parsed.nodes) {
      const embedding = await this.input.memory.embedText(draft.content);
      const added = graph.addNode({
        id: randomUUID(),
        content: draft.content.trim(),
        type: draft.type,
        embedding: embedding ?? [],
        activation_level: 0,
        activation_history: [],
        base_level_activation: Number.NEGATIVE_INFINITY,
        emotional_valence: draft.emotional_valence ?? 0,
        created_at: now,
        last_activated_at: now,
        metadata: {
          channel: input.channel,
          extracted_from: "dialogue"
        }
      } satisfies MemoryNode);
      contentToId.set(draft.content.trim(), added.id);
    }

    for (const draft of parsed.edges) {
      const sourceId = contentToId.get(draft.source_content.trim());
      const targetId = contentToId.get(draft.target_content.trim());
      if (!sourceId || !targetId || sourceId === targetId) {
        continue;
      }

      graph.addEdge({
        id: randomUUID(),
        source: sourceId,
        target: targetId,
        relation_type: draft.relation_type,
        weight: draft.weight ?? 0.6,
        created_at: now,
        last_activated_at: now
      } satisfies MemoryEdge);
    }

    graph.serialize();
    const residue = [normalizedUser, normalizedAssistant]
      .filter((value) => value.length > 0)
      .join("\n");
    if (residue) {
      this.recentDialogueResidue.push(residue);
      if (this.recentDialogueResidue.length > 10) {
        this.recentDialogueResidue.shift();
      }
      this.lastDialogueTime = now;
    }
  }

  async getDebugSnapshot(): Promise<CognitionDebugSnapshot> {
    await this.ensureInitialized();
    return {
      graph: this.requireGraph().toJSON(),
      thoughts: this.requireThoughtPool().toJSON(),
      config: this.requireConfig(),
      lastLogs: await this.readRecentLogs()
    };
  }

  async triggerManualSpread(text: string): Promise<{
    entry: ActivationLogEntry;
    snapshot: CognitionDebugSnapshot;
  }> {
    await this.ensureInitialized();
    await this.repairGraphEmbeddingsIfNeeded();
    const entry = await this.requireLoop().triggerManualSpread(text);
    this.requireGraph().serialize();
    return {
      entry,
      snapshot: await this.getDebugSnapshot()
    };
  }

  async updateConfig(partialConfig: CognitionConfigPatch): Promise<CognitionConfig> {
    await this.ensureInitialized();
    const next = await patchCognitionConfig(this.input.paths, this.requireConfig(), partialConfig);
    this.cognitionConfig = next;
    this.requireGraph().setGraphMaintenanceConfig(next.graph_maintenance);
    if (this.loop?.isRunning()) {
      this.loop.stop();
      this.loop.start();
    }
    return next;
  }

  async getHealthMetrics(): Promise<HealthMetrics> {
    await this.ensureInitialized();
    return this.requireLoop().getHealthMetrics();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.cognitionConfig = await loadCognitionConfig(this.input.paths);
    this.graph = new MemoryGraphStore(this.input.paths, this.cognitionConfig.graph_maintenance);
    this.thoughtPool = new ThoughtPool(this.input.paths);
    this.lastExpressionTime = await this.loadLastExpressionTime();
    this.loop = new SubconsciousLoop({
      graph: this.graph,
      thoughtPool: this.thoughtPool,
      memory: this.input.memory,
      modelFactory: this.modelFactory,
      logger: this.input.logger,
      paths: {
        cognitionActivationLogPath: this.input.paths.cognitionActivationLogPath
      },
      getAppConfig: () => this.input.getConfig(),
      getCognitionConfig: () => this.requireConfig(),
      getUserOnline: () => this.input.getUserOnline?.() ?? true,
      getUserActivityState: () => this.input.getUserActivityState?.() ?? {
        online: this.input.getUserOnline?.() ?? true,
        last_active: null
      },
      getRecentDialogueResidue: () => [...this.recentDialogueResidue],
      getLastDialogueTime: () => this.lastDialogueTime,
      getLastExpressionTime: () => this.lastExpressionTime,
      setLastExpressionTime: (value) => {
        this.lastExpressionTime = value;
      },
      onProactiveMessage: async (payload) => {
        await Promise.resolve(this.input.onProactiveMessage?.(payload));
      },
      onTickCompleted: async (entry) => {
        await Promise.resolve(this.input.onTickCompleted?.(entry));
      }
    });
    this.initialized = true;
    await this.repairGraphEmbeddingsIfNeeded();
  }

  private async loadLastExpressionTime(): Promise<number> {
    const logs = await this.readRecentLogs();
    return logs
      .filter((entry) => entry.expression_produced)
      .map((entry) => entry.timestamp)
      .sort((left, right) => right - left)[0] ?? 0;
  }

  private async readRecentLogs(): Promise<ActivationLogEntry[]> {
    const rows = await readJsonlFile<ActivationLogEntry>(this.input.paths.cognitionActivationLogPath);
    return rows.slice(-100);
  }

  private async repairGraphEmbeddingsIfNeeded(): Promise<void> {
    if (this.embeddingRepairPromise) {
      await this.embeddingRepairPromise;
      return;
    }

    this.embeddingRepairPromise = this.runEmbeddingRepair().finally(() => {
      this.embeddingRepairPromise = null;
    });
    await this.embeddingRepairPromise;
  }

  private async runEmbeddingRepair(): Promise<void> {
    const graph = this.requireGraph();
    const nodes = graph.getAllNodes();
    if (nodes.length === 0) {
      return;
    }

    try {
      const probeEmbedding = await this.input.memory.embedText(CognitionEngine.EMBEDDING_PROBE_TEXT);
      const expectedLength = probeEmbedding?.length ?? 0;
      if (expectedLength <= 0) {
        return;
      }

      const repairTargets = nodes.filter((node) => node.embedding.length !== expectedLength);
      if (repairTargets.length === 0) {
        return;
      }

      const repairedAt = Date.now();
      let repairedCount = 0;
      for (const node of repairTargets) {
        const nextEmbedding = await this.input.memory.embedText(node.content);
        if (!nextEmbedding || nextEmbedding.length !== expectedLength) {
          continue;
        }
        graph.replaceNode({
          ...node,
          embedding: nextEmbedding,
          metadata: {
            ...node.metadata,
            embedding_repaired: true,
            embedding_repaired_at: repairedAt
          }
        });
        repairedCount += 1;
      }

      if (repairedCount > 0) {
        graph.serialize();
        this.input.logger.info("cognition", "graph-embeddings-repaired", {
          repaired_count: repairedCount,
          expected_length: expectedLength,
          node_count: nodes.length
        });
      }
    } catch (error) {
      this.input.logger.warn("cognition", "graph-embeddings-repair-failed", undefined, error);
    }
  }

  private requireGraph(): MemoryGraphStore {
    if (!this.graph) {
      throw new Error("cognition graph not initialized");
    }
    return this.graph;
  }

  private requireThoughtPool(): ThoughtPool {
    if (!this.thoughtPool) {
      throw new Error("thought pool not initialized");
    }
    return this.thoughtPool;
  }

  private requireLoop(): SubconsciousLoop {
    if (!this.loop) {
      throw new Error("subconscious loop not initialized");
    }
    return this.loop;
  }

  private requireConfig(): CognitionConfig {
    if (!this.cognitionConfig) {
      throw new Error("cognition config not initialized");
    }
    return this.cognitionConfig;
  }
}
