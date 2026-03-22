import { randomUUID } from "node:crypto";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import type { AppConfig } from "@shared/types";
import {
  memoryEdgeRelationSchema,
  memoryNodeTypeSchema,
  type ActivationLogEntry,
  type BroadcastSummary,
  type ColdArchiveStats,
  type CognitionConfig,
  type CognitionConfigPatch,
  type ConsolidationReport,
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
import { EmotionStateManager } from "./workspace/emotion-state";
import { PredictionEngine } from "./activation/prediction-coding";
import { AttentionSchema } from "./workspace/attention-schema";
import { GlobalWorkspace } from "./workspace/global-workspace";
import { ColdArchive } from "./consolidation/cold-archive";
import { ConsolidationEngine } from "./consolidation/consolidation-engine";
import { GistExtractor } from "./consolidation/gist-extraction";
import { SleepReplay } from "./consolidation/sleep-replay";

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
  private emotionState: EmotionStateManager | null = null;
  private predictionEngine: PredictionEngine | null = null;
  private attentionSchema: AttentionSchema | null = null;
  private globalWorkspace: GlobalWorkspace | null = null;
  private coldArchive: ColdArchive | null = null;
  private consolidationEngine: ConsolidationEngine | null = null;

  constructor(private readonly input: CognitionEngineInput) {
    this.modelFactory = new ModelFactory(() => this.input.getConfig());
  }

  async start(): Promise<void> {
    await this.ensureInitialized();
    this.loop?.start();
  }

  async stop(): Promise<void> {
    this.consolidationEngine?.interrupt();
    this.loop?.stop();
    this.graph?.serialize();
    await Promise.all([
      this.emotionState?.persist(),
      this.predictionEngine?.persist(),
      this.attentionSchema?.persist()
    ]);
  }

  async ingestDialogue(input: DialogueIngestInput): Promise<void> {
    await this.ensureInitialized();
    if (this.requireConfig().consolidation.interrupt_on_user_message) {
      this.consolidationEngine?.interrupt();
    }
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
      this.queueEmotionAnalysis(residue);
    }
  }

  async getDebugSnapshot(): Promise<CognitionDebugSnapshot> {
    await this.ensureInitialized();
    return {
      graph: this.requireGraph().toJSON(),
      thoughts: this.requireThoughtPool().toJSON(),
      config: this.requireConfig(),
      lastLogs: await this.readRecentLogs(),
      broadcastHistory: this.requireGlobalWorkspace().getBroadcastHistory(),
      workspace: {
        emotion: this.requireEmotionState().getSnapshot(),
        prediction: this.requirePredictionEngine().getWorkspaceState(),
        attention: this.requireAttentionSchema().getWorkspaceState()
      }
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

  async getBroadcastHistory(): Promise<BroadcastSummary[]> {
    await this.ensureInitialized();
    return this.requireGlobalWorkspace().getBroadcastHistory();
  }

  async triggerConsolidation(): Promise<ConsolidationReport> {
    await this.ensureInitialized();
    return this.requireLoop().triggerConsolidation();
  }

  async getConsolidationReport(): Promise<ConsolidationReport | null> {
    await this.ensureInitialized();
    return this.requireConsolidationEngine().getLastReport();
  }

  async getConsolidationHistory(): Promise<ConsolidationReport[]> {
    await this.ensureInitialized();
    return this.requireConsolidationEngine().getHistory();
  }

  async getArchiveStats(): Promise<ColdArchiveStats> {
    await this.ensureInitialized();
    return this.requireColdArchive().getArchiveStats();
  }

  interruptConsolidation(): void {
    this.consolidationEngine?.interrupt();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.cognitionConfig = await loadCognitionConfig(this.input.paths);
    this.graph = new MemoryGraphStore(this.input.paths, this.cognitionConfig.graph_maintenance);
    this.thoughtPool = new ThoughtPool(this.input.paths);
    this.emotionState = new EmotionStateManager({
      paths: this.input.paths,
      logger: this.input.logger,
      getCognitionConfig: () => this.requireConfig(),
      modelFactory: this.modelFactory,
      getAppConfig: () => this.input.getConfig()
    });
    this.predictionEngine = new PredictionEngine({
      paths: this.input.paths,
      getCognitionConfig: () => this.requireConfig()
    });
    this.attentionSchema = new AttentionSchema({
      paths: this.input.paths,
      getCognitionConfig: () => this.requireConfig()
    });
    await this.emotionState.load();
    await this.predictionEngine.load();
    await this.attentionSchema.load();
    this.coldArchive = new ColdArchive({
      paths: this.input.paths,
      logger: this.input.logger,
      getCognitionConfig: () => this.requireConfig()
    });
    this.globalWorkspace = new GlobalWorkspace({
      graph: this.graph,
      emotionState: this.emotionState,
      predictionEngine: this.predictionEngine,
      attentionSchema: this.attentionSchema,
      logger: this.input.logger,
      getCognitionConfig: () => this.requireConfig()
    });
    const sleepReplay = new SleepReplay({
      graph: this.graph,
      getCognitionConfig: () => this.requireConfig()
    });
    const gistExtractor = new GistExtractor({
      graph: this.graph,
      getCognitionConfig: () => this.requireConfig(),
      summarizeCluster: async (nodes) => {
        const result = await generateText({
          model: this.modelFactory.getCognitionModel(),
          providerOptions: resolveOpenAIStoreOption(this.input.getConfig(), "cognition"),
          prompt: [
            "请将以下一组事件概括成一句抽象总结，不要逐条罗列。",
            nodes.map((node) => `- ${node.content}`).join("\n")
          ].join("\n"),
          maxOutputTokens: 120
        });
        return result.text.trim();
      }
    });
    this.consolidationEngine = new ConsolidationEngine({
      paths: this.input.paths,
      graph: this.graph,
      sleepReplay,
      gistExtractor,
      coldArchive: this.coldArchive,
      logger: this.input.logger,
      getCognitionConfig: () => this.requireConfig(),
      getUserActivityState: () => this.input.getUserActivityState?.() ?? {
        online: this.input.getUserOnline?.() ?? true,
        last_active: null
      }
    });
    await this.consolidationEngine.load();
    this.lastExpressionTime = await this.loadLastExpressionTime();
    this.globalWorkspace.hydrateHistory(await this.loadBroadcastHistory());
    this.loop = new SubconsciousLoop({
      graph: this.graph,
      thoughtPool: this.thoughtPool,
      emotionState: this.emotionState,
      predictionEngine: this.predictionEngine,
      attentionSchema: this.attentionSchema,
      globalWorkspace: this.globalWorkspace,
      coldArchive: this.coldArchive,
      consolidationEngine: this.consolidationEngine,
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

  private async loadBroadcastHistory(): Promise<BroadcastSummary[]> {
    const rows = await this.readRecentLogs();
    return rows
      .map((entry) => {
        if (entry.broadcast_summary) {
          return entry.broadcast_summary;
        }
        if (!entry.broadcast_result) {
          return null;
        }
        return {
          broadcast_id: entry.broadcast_result.broadcast_id,
          timestamp: entry.broadcast_result.packet.timestamp,
          bubble_id: entry.broadcast_result.packet.selected_bubble.id,
          bubble_summary: entry.broadcast_result.packet.selected_bubble.summary || entry.broadcast_result.packet.selected_bubble.id,
          modules_updated: [
            ...(entry.broadcast_result.hebbian_report ? ["hebbian"] : []),
            ...(entry.broadcast_result.emotion_report ? ["emotion"] : []),
            ...(entry.broadcast_result.prediction_report ? ["prediction"] : []),
            ...(entry.broadcast_result.attention_report ? ["attention"] : [])
          ],
          has_errors: entry.broadcast_result.errors.length > 0,
          overlap_warning: entry.broadcast_result.hebbian_report?.overlap_warning ?? false
        } satisfies BroadcastSummary;
      })
      .filter((summary): summary is BroadcastSummary => summary !== null)
      .slice(-this.requireConfig().workspace.broadcast_history_max);
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

  private requireEmotionState(): EmotionStateManager {
    if (!this.emotionState) {
      throw new Error("emotion state not initialized");
    }
    return this.emotionState;
  }

  private requirePredictionEngine(): PredictionEngine {
    if (!this.predictionEngine) {
      throw new Error("prediction engine not initialized");
    }
    return this.predictionEngine;
  }

  private requireAttentionSchema(): AttentionSchema {
    if (!this.attentionSchema) {
      throw new Error("attention schema not initialized");
    }
    return this.attentionSchema;
  }

  private requireGlobalWorkspace(): GlobalWorkspace {
    if (!this.globalWorkspace) {
      throw new Error("global workspace not initialized");
    }
    return this.globalWorkspace;
  }

  private requireColdArchive(): ColdArchive {
    if (!this.coldArchive) {
      throw new Error("cold archive not initialized");
    }
    return this.coldArchive;
  }

  private requireConsolidationEngine(): ConsolidationEngine {
    if (!this.consolidationEngine) {
      throw new Error("consolidation engine not initialized");
    }
    return this.consolidationEngine;
  }

  private requireConfig(): CognitionConfig {
    if (!this.cognitionConfig) {
      throw new Error("cognition config not initialized");
    }
    return this.cognitionConfig;
  }

  private queueEmotionAnalysis(text: string): void {
    if (!this.emotionState) {
      return;
    }

    void this.emotionState.analyzeDialogue(text).catch((error: unknown) => {
      this.input.logger.warn(
        "cognition",
        "emotion_analysis_skipped",
        {
          reason: error instanceof Error ? error.message : String(error)
        },
        error
      );
    });
  }
}
