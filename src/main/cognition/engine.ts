import { generateObject, generateText } from "ai";
import { z } from "zod";
import type { AppConfig } from "@shared/types";
import {
  type ActivationLogEntry,
  type BroadcastSummary,
  type ColdArchiveStats,
  type CombinedDialogueExtractionDraft,
  type CognitionConfig,
  type CognitionConfigPatch,
  type ConsolidationReport,
  type CognitionDebugSnapshot,
  type CognitionLogScope,
  type HealthMetrics,
} from "@shared/cognition";
import { readJsonlFile, readTextFile } from "@main/storage/fs";
import type { CompanionPaths } from "@main/storage/paths";
import type { YobiMemory } from "@main/memory/setup";
import type { ConversationEngine } from "@main/core/conversation";
import { ModelFactory } from "@main/core/model-factory";
import { resolveOpenAIStoreOption } from "@main/core/provider-utils";
import type { AppLogger } from "@main/services/logger";
import { DEFAULT_SOUL_TEXT } from "@main/kernel/init";
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
import { reportCognitionTokenUsage } from "./token-usage";
import { applyCombinedExtraction } from "./ingestion/graph-adapter";
import { populateBundledDefaultGraph } from "./ingestion/default-graph";
import { runColdStart } from "./ingestion/cold-start";
import { buildReplyMemoryBlock as buildReplyMemoryPrompt } from "./retrieval/memory-retrieval";

const factOperationSchema = z.object({
  action: z.enum(["add", "update", "supersede"]),
  fact: z.object({
    entity: z.string().min(1).max(80),
    key: z.string().min(1).max(80),
    value: z.string().min(1).max(400),
    category: z.enum(["identity", "preference", "event", "goal", "relationship", "emotion_pattern"]),
    confidence: z.number().min(0).max(1).default(0.65),
    ttl_class: z.enum(["permanent", "stable", "active", "session"]).default("stable"),
    source: z.string().max(120).optional(),
    source_range: z.string().max(120).optional()
  }).strict()
}).strict();

const combinedExtractionSchema = z.object({
  facts: z.array(z.string().min(1)).default([]),
  fact_operations: z.array(factOperationSchema).max(60).default([]),
  graph: z.object({
    nodes: z.array(
      z.object({
        content: z.string().min(1),
        type: z.enum(["fact", "event", "concept", "person", "intent", "time_marker", "emotion_anchor"]),
        emotional_valence: z.number().min(-1).max(1).optional()
      }).strict()
    ).default([]),
    edges: z.array(
      z.object({
        source_content: z.string().min(1),
        target_content: z.string().min(1),
        type: z.enum(["semantic", "temporal", "causal", "emotional"])
      }).strict()
    ).default([]),
    entity_merges: z.array(
      z.object({
        source_content: z.string().min(1),
        target_content: z.string().min(1)
      }).strict()
    ).default([])
  }).strict().default({
    nodes: [],
    edges: [],
    entity_merges: []
  })
}).strict();

const coldStartSeedSchema = z.object({
  nodes: z.array(
    z.object({
      content: z.string().min(1),
      type: z.enum(["concept", "emotion_anchor", "time_marker", "intent", "person"]),
      emotional_valence: z.number().min(-1).max(1).optional()
    }).strict()
  ).default([]),
  edges: z.array(
    z.object({
      source_content: z.string().min(1),
      target_content: z.string().min(1),
      type: z.enum(["semantic", "temporal", "causal", "emotional"])
    }).strict()
  ).default([])
}).strict();

interface CognitionEngineInput {
  paths: CompanionPaths;
  getConfig: () => AppConfig;
  memory: Pick<YobiMemory, "embedText" | "getProfile" | "listHistoryByCursor">
    & Partial<Pick<YobiMemory, "getFactsStore" | "syncFactEmbeddings">>;
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
  }) => Promise<boolean | void> | boolean | void;
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
    const prompt = [
      "请从以下对话中同时提取句子级 facts、结构化 fact_operations、以及认知图 graph。",
      "当前用户统一写成 {{user}}，AI 助手统一写成 {{yobi}}，第三方人物用对话中最完整的称呼。",
      "graph.nodes 的 type 只能用 fact / event / concept / person / intent；如果内容本身是单个时间词或情绪词，也可直接输出 time_marker / emotion_anchor。",
      "graph.edges 的 type 只能用 semantic / temporal / causal / emotional。",
      "当对话中明确说明两个人物是同一人时，请在 graph.entity_merges 里输出 {source_content, target_content}。",
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
    ].join("\n");
    const result = await generateObject({
      model: this.modelFactory.getCognitionModel(),
      providerOptions: resolveOpenAIStoreOption(appConfig, "cognition"),
      schema: combinedExtractionSchema,
      prompt
    });
    reportCognitionTokenUsage({
      usage: result.usage,
      inputText: prompt,
      outputText: JSON.stringify(result.object ?? {})
    });

    const parsed = combinedExtractionSchema.parse(result.object ?? {}) as CombinedDialogueExtractionDraft;
    const now = Date.now();
    await applyCombinedExtraction({
      paths: this.input.paths,
      graph: this.requireGraph(),
      channel: input.channel,
      draft: parsed,
      cognitionConfig: this.requireConfig(),
      nowMs: now,
      memory: {
        embedText: (text) => this.input.memory.embedText(text),
        getFactsStore: () => {
          if (!this.input.memory.getFactsStore) {
            throw new Error("facts store unavailable");
          }
          return this.input.memory.getFactsStore();
        },
        syncFactEmbeddings: async (facts) => {
          await this.input.memory.syncFactEmbeddings?.(facts);
        }
      }
    });
    this.requireGraph().serialize();
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

  async buildReplyMemoryBlock(text: string): Promise<string> {
    await this.ensureInitialized();
    await this.repairGraphEmbeddingsIfNeeded();
    return buildReplyMemoryPrompt({
      graph: this.requireGraph(),
      userText: text,
      embedText: (value) => this.input.memory.embedText(value),
      getRecentDialogueMessages: async () => {
        const recent = await this.input.memory.listHistoryByCursor({
          threadId: "main",
          resourceId: "main",
          limit: this.requireConfig().retrieval.dedup_lookback_turns * 2
        });
        return recent.items.map((item) => item.text);
      },
      cognitionConfig: this.requireConfig()
    });
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

  async clearLogs(scope: CognitionLogScope): Promise<{ removed: number; remaining: number }> {
    await this.ensureInitialized();
    return this.requireLoop().clearActivationLogs(scope);
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

  async regenerateGraphFromSoul(): Promise<{ accepted: boolean; message: string }> {
    await this.ensureInitialized();

    const nextGraph = new MemoryGraphStore(this.input.paths, this.requireConfig().graph_maintenance);
    nextGraph.reset();

    const soulMarkdown = await readTextFile(this.input.paths.soulPath, "");
    let result: { created: boolean; nodeCount: number; edgeCount: number };
    if (soulMarkdown.trim() === DEFAULT_SOUL_TEXT.trim()) {
      result = await populateBundledDefaultGraph({
        graph: nextGraph,
        cognitionConfig: this.requireConfig()
      });
    } else {
      result = await runColdStart({
        paths: this.input.paths,
        graph: nextGraph,
        cognitionConfig: this.requireConfig(),
        soulMarkdown,
        embedText: (text) => this.input.memory.embedText(text),
        generateSeeds: ({ soulMarkdown, targetNodeCount }) =>
          this.generateColdStartSeeds({
            soulMarkdown,
            targetNodeCount
          })
      });
    }

    const serialized = nextGraph.serialize();
    const wasRunning = this.loop?.isRunning() ?? false;
    if (wasRunning) {
      this.loop?.stop();
    }

    try {
      this.consolidationEngine?.interrupt();
      this.requireGraph().deserialize(serialized);
      this.thoughtPool?.reset();
      this.attentionSchema?.reset();
      await this.attentionSchema?.persist();
      return {
        accepted: true,
        message: `认知图已按当前 SOUL 重建（${result.nodeCount} 个节点，${result.edgeCount} 条边）。`
      };
    } finally {
      if (wasRunning) {
        this.loop?.start();
      }
    }
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
    if (this.graph.getStatistics().nodeCount === 0) {
      await populateBundledDefaultGraph({
        graph: this.graph,
        cognitionConfig: this.cognitionConfig
      });
      this.graph.serialize();
    }
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
    if (this.attentionSchema.pruneInvalidFocusNodes((nodeId) => Boolean(this.graph?.getNode(nodeId))) > 0) {
      await this.attentionSchema.persist();
    }
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
        const prompt = [
          "请将以下一组事件概括成一句抽象总结，不要逐条罗列。",
          nodes.map((node) => `- ${node.content}`).join("\n")
        ].join("\n");
        const result = await generateText({
          model: this.modelFactory.getCognitionModel(),
          providerOptions: resolveOpenAIStoreOption(this.input.getConfig(), "cognition"),
          prompt,
          maxOutputTokens: 120
        });
        reportCognitionTokenUsage({
          usage: result.usage,
          inputText: prompt,
          outputText: result.text
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
        return await Promise.resolve(this.input.onProactiveMessage?.(payload));
      },
      onTickCompleted: async (entry) => {
        await Promise.resolve(this.input.onTickCompleted?.(entry));
      }
    });
    this.initialized = true;
  }

  private async generateColdStartSeeds(input: {
    soulMarkdown: string;
    targetNodeCount: number;
  }): Promise<z.infer<typeof coldStartSeedSchema>> {
    const prompt = [
      "请根据以下 soul 文本，输出一个 JSON，包含用于认知图冷启动的种子 nodes 和建议 edges。",
      `目标节点数约 ${input.targetNodeCount} 个，覆盖五个维度：性格特征、兴趣领域、情感锚点、时间节点、交互意图。`,
      "节点字段必须包含 content、type、emotional_valence；边字段必须包含 source_content、target_content、type。",
      "只返回 JSON，不要解释。",
      input.soulMarkdown
    ].join("\n");
    const result = await generateObject({
      model: this.modelFactory.getCognitionModel(),
      providerOptions: resolveOpenAIStoreOption(this.input.getConfig(), "cognition"),
      schema: coldStartSeedSchema,
      prompt
    });
    reportCognitionTokenUsage({
      usage: result.usage,
      inputText: prompt,
      outputText: JSON.stringify(result.object ?? {})
    });
    return coldStartSeedSchema.parse(result.object ?? {
      nodes: [],
      edges: []
    });
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
