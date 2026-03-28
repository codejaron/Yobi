import { generateText } from "ai";
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
import { generateStructuredJson } from "./ingestion/structured-json";
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

interface DialogueTranscriptEntry {
  role: "user" | "assistant";
  text: string;
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
  private pendingDialogueRounds: DialogueIngestInput[] = [];
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
    const now = Date.now();
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

    this.pendingDialogueRounds.push({
      channel: input.channel,
      chatId: input.chatId,
      userText: normalizedUser,
      assistantText: normalizedAssistant
    });
    if (this.pendingDialogueRounds.length < this.getDialogueBatchRounds()) {
      return;
    }

    const roundsToProcess = [...this.pendingDialogueRounds];
    await this.processDialogueBatch(roundsToProcess);
    this.pendingDialogueRounds = [];
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
        const prompt = buildClusterSummaryPrompt(nodes);
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
    const prompt = buildColdStartSeedPrompt(input);
    const result = await generateStructuredJson({
      model: this.modelFactory.getCognitionModel(),
      providerOptions: resolveOpenAIStoreOption(this.input.getConfig(), "cognition"),
      schema: coldStartSeedSchema,
      maxAttempts: 3,
      prompt
    });
    reportCognitionTokenUsage({
      usage: result.usage,
      inputText: prompt,
      outputText: result.text
    });
    return result.object;
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

  protected async processDialogueBatch(
    rounds: Array<{ userText?: string; assistantText: string; channel?: string; chatId?: string }>
  ): Promise<void> {
    const normalizedRounds = rounds
      .map((round) => ({
        channel: typeof round.channel === "string" && round.channel.trim() ? round.channel : "console",
        chatId: typeof round.chatId === "string" ? round.chatId : undefined,
        userText: round.userText?.trim() ?? "",
        assistantText: round.assistantText.trim()
      }))
      .filter((round) => round.userText.length > 0 || round.assistantText.length > 0);
    if (normalizedRounds.length === 0) {
      return;
    }

    const transcript = normalizedRounds.flatMap<DialogueTranscriptEntry>((round) => {
      const entries: DialogueTranscriptEntry[] = [];
      if (round.userText.length > 0) {
        entries.push({
          role: "user",
          text: round.userText
        });
      }
      if (round.assistantText.length > 0) {
        entries.push({
          role: "assistant",
          text: round.assistantText
        });
      }
      return entries;
    });
    const latestRound = normalizedRounds[normalizedRounds.length - 1]!;
    const latestUserMessage =
      [...transcript].reverse().find((entry) => entry.role === "user")?.text
      ?? latestRound.assistantText;

    const appConfig = this.input.getConfig();
    const prompt = buildDialogueExtractionPrompt({
      channel: latestRound.channel,
      chatId: latestRound.chatId ?? null,
      transcript,
      latestUserMessage,
      nowIso: new Date().toISOString()
    });
    const result = await generateStructuredJson({
      model: this.modelFactory.getCognitionModel(),
      providerOptions: resolveOpenAIStoreOption(appConfig, "cognition"),
      schema: combinedExtractionSchema,
      maxAttempts: 3,
      prompt
    });
    reportCognitionTokenUsage({
      usage: result.usage,
      inputText: prompt,
      outputText: result.text
    });

    const parsed = result.object as CombinedDialogueExtractionDraft;
    const now = Date.now();
    await applyCombinedExtraction({
      paths: this.input.paths,
      graph: this.requireGraph(),
      channel: latestRound.channel,
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
    this.queueEmotionAnalysis(transcript.map((entry) => entry.text).join("\n"));
  }

  private getDialogueBatchRounds(): number {
    const configured = this.input.getConfig().memory.cognitionBatchRounds;
    if (!Number.isFinite(configured)) {
      return 10;
    }
    return Math.max(1, Math.min(50, Math.floor(configured)));
  }
}

export function buildDialogueExtractionPrompt(input: {
  channel: string;
  chatId: string | null;
  transcript?: DialogueTranscriptEntry[];
  latestUserMessage?: string;
  user?: string;
  assistant?: string;
  nowIso: string;
}): string {
  const transcript = (input.transcript && input.transcript.length > 0
    ? input.transcript
    : [
        ...(input.user?.trim()
          ? [
              {
                role: "user" as const,
                text: input.user.trim()
              }
            ]
          : []),
        ...(input.assistant?.trim()
          ? [
              {
                role: "assistant" as const,
                text: input.assistant.trim()
              }
            ]
          : [])
      ]).filter((entry) => entry.text.length > 0);
  const latestUserMessage =
    input.latestUserMessage?.trim()
    || [...transcript].reverse().find((entry) => entry.role === "user")?.text
    || transcript[transcript.length - 1]?.text
    || "";

  return [
    "Extract sentence-level facts, structured fact_operations, and a memory graph from the dialogue below.",
    "Return exactly one JSON object with the keys facts, fact_operations, and graph.",
    "All natural-language text values in the output must use the same language as the latest user message.",
    "This includes facts[] strings, fact.value, and graph.nodes[].content.",
    "JSON field names and enum values stay in English.",
    "Do not translate placeholders, proper names, product names, code, commands, file paths, version numbers, or quoted text.",
    "Use {{user}} for the human user and {{yobi}} for the assistant. Use the most complete name found in the dialogue for third parties.",
    "graph.edges[].source_content/target_content and graph.entity_merges must reuse the exact node content or mention text from the dialogue or graph.",
    "facts must be an array of short factual strings.",
    "fact_operations must be an array of objects with action and fact.",
    "action must be one of add, update, supersede.",
    "fact must include entity, key, value, category, confidence, ttl_class, and may include source and source_range.",
    "fact.key should remain concise and stable across turns for the same kind of fact.",
    "category must be one of identity, preference, event, goal, relationship, emotion_pattern.",
    "ttl_class must be one of permanent, stable, active, session.",
    "graph must be an object with nodes, edges, and entity_merges.",
    "graph.nodes[].type must be one of fact, event, concept, person, intent, time_marker, emotion_anchor.",
    "graph.edges[].type must be one of semantic, temporal, causal, emotional.",
    "If the dialogue explicitly says two people are the same person, include {source_content, target_content} in graph.entity_merges.",
    "Do not output id, label, metadata, or any other extra fields.",
    "Do not include markdown fences or explanations. Return JSON only.",
    "Example output:",
    JSON.stringify(
      {
        facts: [
          "{{user}} likes hot ramen"
        ],
        fact_operations: [
          {
            action: "add",
            fact: {
              entity: "{{user}}",
              key: "food_preference",
              value: "hot ramen",
              category: "preference",
              confidence: 0.9,
              ttl_class: "stable"
            }
          }
        ],
        graph: {
          nodes: [
            {
              content: "{{user}}",
              type: "person"
            },
            {
              content: "{{user}} likes hot ramen",
              type: "fact",
              emotional_valence: 0.3
            }
          ],
          edges: [
            {
              source_content: "{{user}}",
              target_content: "{{user}} likes hot ramen",
              type: "semantic"
            }
          ],
          entity_merges: []
        }
      },
      null,
      2
    ),
    "Dialogue input:",
    JSON.stringify(
      {
        channel: input.channel,
        chat_id: input.chatId,
        latest_user_message: latestUserMessage,
        transcript,
        now_iso: input.nowIso
      },
      null,
      2
    )
  ].join("\n");
}

export function buildClusterSummaryPrompt(nodes: ReadonlyArray<{ content: string }>): string {
  return [
    "请将以下一组事件概括成一句抽象总结，不要逐条罗列。",
    "请沿用这些事件本身的语言，不要翻译。",
    nodes.map((node) => `- ${node.content}`).join("\n")
  ].join("\n");
}

export function buildColdStartSeedPrompt(input: {
  soulMarkdown: string;
  targetNodeCount: number;
}): string {
  return [
    "Read the soul text below and return one JSON object with cold-start seed nodes and suggested edges for the memory graph.",
    `Target about ${input.targetNodeCount} nodes across five dimensions: personality traits, interests, emotional anchors, time markers, and interaction intents.`,
    "The JSON must contain keys nodes and edges.",
    "Each node must include content, type, and optional emotional_valence.",
    "The content field of each node must use the same language as the soul text. Do not translate.",
    "Each edge must include source_content, target_content, and type.",
    "Do not include markdown fences or explanations. Return JSON only.",
    input.soulMarkdown
  ].join("\n");
}
