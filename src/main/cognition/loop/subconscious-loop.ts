import type { AppConfig, HistoryMessage } from "@shared/types";
import type {
  ActivationLogEntry,
  CognitionConfig,
  CognitionLogScope,
  GraphStatsSnapshot,
  HealthMetrics
} from "@shared/cognition";
import { isManualActivationLogEntry } from "@shared/cognition";
import type { AppLogger } from "@main/services/logger";
import { appendJsonlLine, readJsonlFile, writeJsonlFileAtomic } from "@main/storage/fs";
import type { ModelFactory } from "@main/core/model-factory";
import type { YobiMemory } from "@main/memory/setup";
import { spread } from "../activation/spreading-activation";
import { applyGlobalEdgeDecay } from "../graph/edge-decay";
import { applyHebbianLearning } from "../graph/hebbian-learning";
import { MemoryGraphStore } from "../graph/memory-graph";
import { ThoughtPool } from "../thoughts/thought-bubble";
import { evaluateAndExpress } from "../evaluation/expression-gate";
import { mean, linearRegressionSlope } from "../utils/math";
import { PoissonHeartbeat } from "./heartbeat";
import { signalToSeeds, type CognitionSignal } from "./signal-to-seed";
import { selectTriggersWithOptions } from "./trigger-sources";
import { EmotionStateManager } from "../workspace/emotion-state";
import { PredictionEngine } from "../activation/prediction-coding";
import { AttentionSchema } from "../workspace/attention-schema";
import { GlobalWorkspace } from "../workspace/global-workspace";
import { ColdArchive } from "../consolidation/cold-archive";
import { ConsolidationEngine } from "../consolidation/consolidation-engine";

const PRIMARY_RESOURCE_ID = "primary-user";
const PRIMARY_THREAD_ID = "primary-thread";

function resolveGraphLabel(graph: MemoryGraphStore, nodeId: string): string {
  return graph.getNode(nodeId)?.content ?? "失效节点";
}

function sortActivationEntries(entries: Array<[string, number]>): Array<[string, number]> {
  return entries.sort((left, right) => {
    if (right[1] !== left[1]) {
      return right[1] - left[1];
    }
    return left[0].localeCompare(right[0]);
  });
}

function summarizeRound(
  round: NonNullable<ActivationLogEntry["path_log"]>[number],
  graph: MemoryGraphStore
): NonNullable<ActivationLogEntry["hop_summaries"]>[number] {
  const surviving = round.trimmed_totals ?? round.gated_totals ?? [];
  const nodes = [...surviving]
    .sort((left, right) => {
      if (right.activation !== left.activation) {
        return right.activation - left.activation;
      }
      return left.node_id.localeCompare(right.node_id);
    })
    .slice(0, 3)
    .map((item) => ({
      node_id: item.node_id,
      label: resolveGraphLabel(graph, item.node_id),
      activation: item.activation
    }));
  return {
    depth: round.depth,
    nodes
  };
}

function deduplicateSeeds(seeds: Array<{ nodeId: string; energy: number }>): Array<{ nodeId: string; energy: number }> {
  const byId = new Map<string, { nodeId: string; energy: number }>();
  for (const seed of seeds) {
    const current = byId.get(seed.nodeId);
    if (!current || seed.energy > current.energy) {
      byId.set(seed.nodeId, seed);
    }
  }
  return [...byId.values()].sort((left, right) => {
    if (right.energy !== left.energy) {
      return right.energy - left.energy;
    }
    return left.nodeId.localeCompare(right.nodeId);
  });
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function captureEdgeWeights(graph: MemoryGraphStore): Map<string, number> {
  return new Map(graph.getAllEdges().map((edge) => [edge.id, edge.weight]));
}

function diffEdgeWeights(graph: MemoryGraphStore, before: ReadonlyMap<string, number>): Map<string, number> {
  const deltas = new Map<string, number>();
  for (const edge of graph.getAllEdges()) {
    const previous = before.get(edge.id);
    if (previous === undefined) {
      continue;
    }
    const delta = edge.weight - previous;
    if (delta !== 0) {
      deltas.set(edge.id, delta);
    }
  }
  return deltas;
}

function standardDeviation(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const avg = mean(values);
  const variance = mean(values.map((value) => (value - avg) * (value - avg)));
  return Math.sqrt(variance);
}

function computeGraphStats(graph: MemoryGraphStore): GraphStatsSnapshot {
  const nodes = graph.getAllNodes();
  const edges = graph.getAllEdges();
  const weights = edges.map((edge) => edge.weight);
  const activations = nodes.map((node) => node.activation_level);
  return {
    avg_weight: mean(weights),
    median_weight: median(weights),
    std_weight: standardDeviation(weights),
    min_weight: weights.length > 0 ? Math.min(...weights) : 0,
    max_weight: weights.length > 0 ? Math.max(...weights) : 0,
    node_count: nodes.length,
    edge_count: edges.length,
    avg_activation: mean(activations)
  };
}

function emptyHealthMetrics(heartbeatStats: ReturnType<PoissonHeartbeat["getStats"]>): HealthMetrics {
  return {
    total_ticks: 0,
    uptime_hours: 0,
    empty_tick_ratio: 0,
    expression_ratio: 0,
    avg_top1_activation: 0,
    weight_mean_current: 0,
    weight_mean_trend: 0,
    path_diversity: 0,
    broadcast_overlap_warnings_count: 0,
    alerts: [],
    heartbeat_stats: heartbeatStats
  };
}

interface SubconsciousLoopInput {
  graph: MemoryGraphStore;
  thoughtPool: ThoughtPool;
  emotionState: EmotionStateManager;
  predictionEngine: PredictionEngine;
  attentionSchema: AttentionSchema;
  globalWorkspace: GlobalWorkspace;
  coldArchive?: ColdArchive | null;
  consolidationEngine?: ConsolidationEngine | null;
  memory: Pick<YobiMemory, "embedText" | "getProfile" | "listHistoryByCursor">;
  modelFactory: ModelFactory;
  logger: AppLogger;
  paths: {
    cognitionActivationLogPath: string;
  };
  getAppConfig: () => AppConfig;
  getCognitionConfig: () => CognitionConfig;
  getUserOnline: () => boolean;
  getUserActivityState?: () => { online: boolean; last_active: number | null };
  getRecentDialogueResidue?: () => string[];
  getLastDialogueTime?: () => number | null;
  getLastExpressionTime: () => number;
  setLastExpressionTime: (value: number) => void;
  onProactiveMessage: (input: {
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
  onTickCompleted: (entry: ActivationLogEntry) => Promise<void> | void;
}

export class SubconsciousLoop {
  private heartbeat: PoissonHeartbeat | null = null;
  private running = false;
  private tickCount = 0;
  private automaticTickCount = 0;
  private startTime = 0;
  private recentLogsBuffer: ActivationLogEntry[] = [];

  constructor(private readonly input: SubconsciousLoopInput) {}

  start(): void {
    if (this.running) {
      this.heartbeat?.updateConfig(this.input.getCognitionConfig().loop);
      return;
    }

    this.running = true;
    if (this.startTime === 0) {
      this.startTime = Date.now();
    }
    if (!this.heartbeat) {
      this.heartbeat = new PoissonHeartbeat(this.input.getCognitionConfig().loop, async () => {
        await this.runAutomaticTick();
      });
    } else {
      this.heartbeat.updateConfig(this.input.getCognitionConfig().loop);
    }
    this.heartbeat.start();
  }

  stop(): void {
    this.running = false;
    this.heartbeat?.stop();
  }

  isRunning(): boolean {
    return this.running;
  }

  getRecentLogs(count: number): ActivationLogEntry[] {
    return this.recentLogsBuffer.slice(-Math.max(0, count)).map((entry) => ({ ...entry }));
  }

  async clearActivationLogs(scope: CognitionLogScope): Promise<{ removed: number; remaining: number }> {
    const keepEntry = (entry: ActivationLogEntry) => {
      const isManual = isManualActivationLogEntry(entry);
      return scope === "timeline" ? isManual : !isManual;
    };

    const rows = await readJsonlFile<ActivationLogEntry>(this.input.paths.cognitionActivationLogPath);
    const filteredRows = rows.filter(keepEntry);
    await writeJsonlFileAtomic(this.input.paths.cognitionActivationLogPath, filteredRows);

    this.recentLogsBuffer = this.recentLogsBuffer.filter(keepEntry).slice(-200);

    return {
      removed: rows.length - filteredRows.length,
      remaining: filteredRows.length
    };
  }

  getHealthMetrics(): HealthMetrics {
    const heartbeatStats = this.heartbeat?.getStats() ?? {
      ticks_total: 0,
      avg_interval_actual_ms: 0,
      last_tick_time: 0,
      next_scheduled_time: null
    };
    const logs = this.recentLogsBuffer.slice(-100);
    if (logs.length === 0) {
      return emptyHealthMetrics(heartbeatStats);
    }

    const emptyTicks = logs.filter((entry) => entry.seeds.length === 0).length;
    const expressions = logs.filter((entry) => entry.expression_produced).length;
    const top1Ids = logs.map((entry) => entry.top_activated[0]?.node_id).filter((value): value is string => Boolean(value));
    const uniqueTop1 = new Set(top1Ids).size;
    const weightPoints: Array<[number, number]> = logs
      .map((entry, index) => [index, entry.graph_stats?.avg_weight ?? 0] as [number, number]);
    const metrics: HealthMetrics = {
      total_ticks: this.tickCount,
      uptime_hours: this.startTime > 0 ? (Date.now() - this.startTime) / 3_600_000 : 0,
      empty_tick_ratio: emptyTicks / logs.length,
      expression_ratio: expressions / logs.length,
      avg_top1_activation: mean(logs.map((entry) => entry.top_activated[0]?.activation ?? 0)),
      weight_mean_current: logs[logs.length - 1]?.graph_stats?.avg_weight ?? 0,
      weight_mean_trend: linearRegressionSlope(weightPoints),
      path_diversity: logs.length > 0 ? uniqueTop1 / logs.length : 0,
      broadcast_overlap_warnings_count: logs.filter((entry) => entry.broadcast_result?.hebbian_report?.overlap_warning).length,
      alerts: [],
      heartbeat_stats: heartbeatStats
    };

    if (metrics.weight_mean_trend > 0.001) {
      metrics.alerts.push({ level: "warning", msg: "权重均值持续上升，Hebbian 增长可能失控" });
    }
    if (metrics.weight_mean_trend < -0.005) {
      metrics.alerts.push({ level: "warning", msg: "权重均值持续下降，被动衰减可能过强" });
    }
    if (metrics.empty_tick_ratio > 0.5) {
      metrics.alerts.push({ level: "warning", msg: "超过 50% 心跳无法找到种子，图可能太稀疏" });
    }
    if (metrics.expression_ratio > 0.3) {
      metrics.alerts.push({ level: "warning", msg: "表达频率过高（>30%），表达阈值可能太低" });
    }
    if (metrics.expression_ratio === 0 && this.tickCount > 50) {
      metrics.alerts.push({ level: "info", msg: "已运行 50+ 次心跳未表达，阈值可能太高" });
    }
    if (metrics.path_diversity < 0.08 && logs.length >= 20) {
      metrics.alerts.push({ level: "warning", msg: "路径多样性过低，扩散可能退化到固定路径" });
    }
    if (metrics.broadcast_overlap_warnings_count > 5) {
      metrics.alerts.push({ level: "warning", msg: "广播 Hebbian 叠加告警过多，建议降低 broadcast_hebbian_rate" });
    }

    return metrics;
  }

  async tick(): Promise<ActivationLogEntry> {
    return this.runAutomaticTick();
  }

  async triggerConsolidation(): Promise<import("@shared/cognition").ConsolidationReport> {
    return this.runConsolidation("manual");
  }

  async triggerManualSpread(text: string): Promise<ActivationLogEntry> {
    return this.runCycle({
      signals: [
        {
          type: "manual_signal",
          payload: {
            text
          }
        }
      ],
      triggerType: "manual_signal",
      triggerSources: [
        {
          type: "manual_signal",
          source_description: `手动触发：${text.slice(0, 30)}`
        }
      ],
      manualText: text,
      forceUserOnline: true,
      automatic: false
    });
  }

  private async runAutomaticTick(): Promise<ActivationLogEntry> {
    const config = this.input.getCognitionConfig();
    const userActivityState = this.input.getUserActivityState?.() ?? {
      online: this.input.getUserOnline(),
      last_active: null
    };
    const triggers = selectTriggersWithOptions(
      this.input.graph,
      this.input.getRecentDialogueResidue?.() ?? [],
      this.input.getLastDialogueTime?.() ?? null,
      userActivityState,
      config.triggers,
      {
        nowMs: Date.now(),
        decayD: config.actr.decay_d
      }
    );
    const entry = await this.runCycle({
      signals: triggers.map((trigger) => this.toCognitionSignal(trigger)),
      triggerType: triggers[0]?.type ?? "time_signal",
      triggerSources: triggers.map((trigger) => ({
        type: trigger.type,
        source_description: trigger.source_description
      })),
      automatic: true
    });
    await this.maybeRunConsolidation();
    return entry;
  }

  private async runCycle(input: {
    signals: CognitionSignal[];
    triggerType: string;
    triggerSources: Array<{ type: string; source_description: string }>;
    manualText?: string;
    forceUserOnline?: boolean;
    automatic: boolean;
  }): Promise<ActivationLogEntry> {
    const config = this.input.getCognitionConfig();
    const nowMs = Date.now();
    this.tickCount += 1;
    const currentTickId = this.tickCount;
    if (input.automatic) {
      this.automaticTickCount += 1;
    }

    const startedAt = Date.now();
    const seedBatches: Array<Array<{ nodeId: string; energy: number }>> = [];
    for (const signal of input.signals) {
      seedBatches.push(await signalToSeeds(
        signal,
        this.input.graph,
        (text) => this.input.memory.embedText(text),
        {
          actr: config.actr,
          nowMs,
          coldArchive: this.input.coldArchive ?? undefined
        }
      ));
    }
    const seeds = this.input.attentionSchema.injectFocusSeeds(deduplicateSeeds(seedBatches.flat()), {
      isValidNode: (nodeId) => Boolean(this.input.graph.getNode(nodeId))
    });
    this.resetGraphActivationLevels(0);

    if (seeds.length === 0) {
      const decayLog = applyGlobalEdgeDecay(this.input.graph, {
        passive_decay_rate: config.hebbian.passive_decay_rate,
        weight_min: config.hebbian.weight_min
      });
      this.input.thoughtPool.decayAll(0.92);
      this.input.emotionState.decay();
      const predictionWorkspace = this.input.predictionEngine.getWorkspaceState();
      const entry: ActivationLogEntry = {
        timestamp: nowMs,
        trigger_type: input.triggerType,
        trigger_sources: input.triggerSources,
        duration_ms: Date.now() - startedAt,
        seeds: [],
        top_activated: [],
        path_log: [],
        hop_summaries: [],
        config_snapshot: this.buildConfigSnapshot(config),
        activated_count: 0,
        activation_peak: 0,
        bubbles_generated: 0,
        bubble_passed_filter: false,
        expression_produced: false,
        expression_text: null,
        manual_text: input.manualText ?? null,
        expression_reason: "no-seeds",
        hebbian_log: null,
        edge_decay_log: decayLog,
        graph_stats: computeGraphStats(this.input.graph),
        prediction_status: predictionWorkspace.warming_up ? "warming_up" : "active",
        prediction_progress: predictionWorkspace.progress,
        prediction_similarity: predictionWorkspace.last_similarity ?? null,
        surprising_nodes: [],
        familiar_nodes: [],
        emotion_snapshot: {
          valence: this.input.emotionState.getSnapshot().valence,
          arousal: this.input.emotionState.getSnapshot().arousal,
          source: this.input.emotionState.getSnapshot().source
        },
        attention_focus: this.input.attentionSchema.getWorkspaceState().focus_node_ids,
        broadcast_result: null,
        broadcast_summary: null
      };
      await this.finalizeTick(entry, input.automatic);
      return entry;
    }

    const rawActivationResult = spread(this.input.graph, seeds, {
      spreading: config.spreading,
      inhibition: config.inhibition,
      sigmoid: config.sigmoid
    }, {
      emotionState: this.input.emotionState,
      emotionConfig: config.emotion
    });
    const allNodeIds = this.input.graph.getAllNodes().map((node) => node.id);
    const predictionResult = this.input.predictionEngine.applyPredictionCoding(
      rawActivationResult.activated,
      allNodeIds
    );
    const modulatedActivationResult = {
      activated: predictionResult.activated,
      path_log: rawActivationResult.path_log
    };
    this.input.attentionSchema.updateFromActivation(rawActivationResult);

    // Structural learning stays coupled to the raw diffusion result. Prediction coding
    // acts as an attentional/output bias only, so it must not rewrite graph weights.
    const rankedActivated = sortActivationEntries([...modulatedActivationResult.activated.entries()]);
    const edgeWeightsBeforeRegularHebbian = captureEdgeWeights(this.input.graph);
    const hebbianLog = applyHebbianLearning(this.input.graph, rawActivationResult.activated, config.hebbian);
    const regularDeltaByEdgeId = diffEdgeWeights(this.input.graph, edgeWeightsBeforeRegularHebbian);
    const decayLog = applyGlobalEdgeDecay(this.input.graph, {
      passive_decay_rate: config.hebbian.passive_decay_rate,
      weight_min: config.hebbian.weight_min
    });

    const topActivated = rankedActivated.slice(0, 10).map(([nodeId, activation]) => ({
      node_id: nodeId,
      label: resolveGraphLabel(this.input.graph, nodeId),
      activation
    }));
    const shouldCreateBubble = (topActivated[0]?.activation ?? 0) >= config.expression.activation_threshold;
    const newBubble = shouldCreateBubble
      ? this.input.thoughtPool.createBubble(
          seeds.map((seed) => seed.nodeId),
          rankedActivated.map(([nodeId, activation]) => ({
            nodeId,
            activation,
            emotional_valence: this.input.graph.getNode(nodeId)?.emotional_valence ?? 0
          })),
          modulatedActivationResult
        )
      : null;
    this.input.thoughtPool.decayAll(0.92, newBubble ? [newBubble.id] : []);
    this.input.emotionState.decay();

    const recentDialogue = await this.getRecentDialogue();
    const userProfile = await this.input.memory.getProfile();
    const candidates = [
      ...this.input.thoughtPool.getMatureBubbles(),
      ...(newBubble ? [newBubble] : [])
    ]
      .filter((bubble) => bubble.activation_peak >= config.expression.activation_threshold)
      .sort((left, right) => right.activation_peak - left.activation_peak);

    let selectedReason = newBubble ? "bubble-created" : "below-bubble-threshold";
    let bubblePassedFilter = false;
    let expressionText: string | null = null;
    let bubbleSummary: string | null = newBubble?.summary?.trim() ? newBubble.summary : null;
    let evaluationScore: number | null = null;
    let evaluationDimensions: ActivationLogEntry["evaluation_dimensions"] = null;
    let broadcastResult: ActivationLogEntry["broadcast_result"] = null;
    let broadcastSummary: ActivationLogEntry["broadcast_summary"] = null;

    for (const candidate of candidates) {
      const evaluation = await evaluateAndExpress({
        bubble: candidate,
        thoughtPool: this.input.thoughtPool,
        graph: this.input.graph,
        recentDialogue,
        userProfile,
        modelFactory: this.input.modelFactory,
        appConfig: this.input.getAppConfig(),
        config,
        lastExpressionTime: this.input.getLastExpressionTime(),
        userOnline: input.forceUserOnline === true ? true : this.input.getUserOnline()
      });
      bubblePassedFilter = bubblePassedFilter || evaluation.bubblePassedFilter;
      bubbleSummary = evaluation.summary ?? bubbleSummary;
      evaluationScore = evaluation.evaluationScore;
      evaluationDimensions = evaluation.evaluationDimensions;
      selectedReason = evaluation.reason;

      if (!evaluation.text) {
        continue;
      }

      try {
        const deliveryResult = await this.input.onProactiveMessage({
          message: evaluation.text,
          metadata: {
            proactive: true,
            source: "yobi"
          },
          recordProactive: true
        });
        if (deliveryResult === false) {
          selectedReason = "delivery-blocked";
          break;
        }
      } catch (error) {
        selectedReason = error instanceof Error ? `send-failed:${error.message}` : `send-failed:${String(error)}`;
        continue;
      }

      expressionText = evaluation.text;
      this.input.thoughtPool.markExpressed(candidate.id);
      this.input.setLastExpressionTime(Date.now());
      if (config.workspace.broadcast_enabled) {
        broadcastResult = this.input.globalWorkspace.broadcast({
          selectedBubble: candidate,
          rawActivationResult: rawActivationResult.activated,
          allNodeIds,
          currentTickId,
          regularDeltaByEdgeId
        });
        broadcastSummary = this.input.globalWorkspace.getBroadcastHistory().slice(-1)[0] ?? null;
      } else {
        this.input.emotionState.updateFromBubble(candidate);
      }
      break;
    }
    if (this.input.predictionEngine.lastRecordedTickId !== currentTickId) {
      this.input.predictionEngine.recordActivationFingerprint(rawActivationResult.activated, allNodeIds, currentTickId);
    }
    const emotionSnapshot = this.input.emotionState.getSnapshot();

    const entry: ActivationLogEntry = {
      timestamp: nowMs,
      trigger_type: input.triggerType,
      trigger_sources: input.triggerSources,
      duration_ms: Date.now() - startedAt,
      seeds: seeds.map((seed) => ({
        node_id: seed.nodeId,
        label: resolveGraphLabel(this.input.graph, seed.nodeId)
      })),
      top_activated: topActivated,
      path_log: rawActivationResult.path_log,
      hop_summaries: rawActivationResult.path_log.map((round) => summarizeRound(round, this.input.graph)),
      config_snapshot: this.buildConfigSnapshot(config),
      activated_count: modulatedActivationResult.activated.size,
      activation_peak: topActivated[0]?.activation ?? 0,
      bubbles_generated: newBubble ? 1 : 0,
      bubble_passed_filter: bubblePassedFilter,
      expression_produced: Boolean(expressionText),
      expression_text: expressionText,
      bubble_id: newBubble?.id ?? null,
      bubble_summary: bubbleSummary,
      evaluation_score: evaluationScore,
      evaluation_dimensions: evaluationDimensions,
      manual_text: input.manualText ?? null,
      expression_reason: selectedReason,
      hebbian_log: hebbianLog,
      edge_decay_log: decayLog,
      graph_stats: computeGraphStats(this.input.graph),
      prediction_status: predictionResult.status,
      prediction_progress: predictionResult.progress,
      prediction_similarity: predictionResult.similarity,
      surprising_nodes: predictionResult.surprisingNodes,
      familiar_nodes: predictionResult.familiarNodes,
      emotion_snapshot: {
        valence: emotionSnapshot.valence,
        arousal: emotionSnapshot.arousal,
        source: emotionSnapshot.source
      },
      attention_focus: this.input.attentionSchema.getWorkspaceState().focus_node_ids,
      broadcast_result: broadcastResult,
      broadcast_summary: broadcastSummary
    };
    await this.finalizeTick(entry, input.automatic);
    return entry;
  }

  private async finalizeTick(entry: ActivationLogEntry, automatic: boolean): Promise<void> {
    this.recentLogsBuffer.push(entry);
    if (this.recentLogsBuffer.length > 200) {
      this.recentLogsBuffer.shift();
    }
    if (!automatic || (automatic && this.automaticTickCount % 10 === 0)) {
      this.input.graph.serialize();
      await Promise.all([
        this.input.emotionState.persist(),
        this.input.predictionEngine.persist(),
        this.input.attentionSchema.persist()
      ]);
    }
    await appendJsonlLine(this.input.paths.cognitionActivationLogPath, entry);
    await Promise.resolve(this.input.onTickCompleted(entry));
  }

  private async maybeRunConsolidation(): Promise<void> {
    if (!this.input.consolidationEngine) {
      return;
    }
    const next = this.input.consolidationEngine.shouldTrigger();
    if (!next.should || !next.trigger) {
      return;
    }
    await this.runConsolidation(next.trigger);
  }

  private async runConsolidation(trigger: "scheduled" | "size_limit" | "manual"): Promise<import("@shared/cognition").ConsolidationReport> {
    if (!this.input.consolidationEngine) {
      throw new Error("consolidation engine not initialized");
    }

    if (this.input.consolidationEngine.isRunning()) {
      const latest = await this.input.consolidationEngine.getLastReport();
      if (latest) {
        return latest;
      }
      throw new Error("consolidation already running");
    }

    this.heartbeat?.pause();
    try {
      const report = await this.input.consolidationEngine.runConsolidation(trigger);
      this.input.graph.serialize();
      return report;
    } finally {
      this.heartbeat?.resume();
    }
  }

  private toCognitionSignal(trigger: {
    type: string;
    payload: Record<string, unknown>;
  }): CognitionSignal {
    switch (trigger.type) {
      case "dialogue_residue":
        return {
          type: "dialogue_residue",
          payload: {
            text: String(trigger.payload.text ?? "")
          }
        };
      case "silence":
        return {
          type: "silence",
          payload: {
            duration_minutes: Number(trigger.payload.duration_minutes ?? 0)
          }
        };
      case "random_walk":
        return {
          type: "random_walk",
          payload: {
            node_id: String(trigger.payload.node_id ?? ""),
            node_content: typeof trigger.payload.node_content === "string" ? trigger.payload.node_content : undefined
          }
        };
      case "low_activation_rescue":
        return {
          type: "low_activation_rescue",
          payload: {
            node_ids: Array.isArray(trigger.payload.node_ids)
              ? trigger.payload.node_ids.map((value) => String(value))
              : []
          }
        };
      case "time_signal":
      default:
        return {
          type: "time_signal",
          payload: {
            hour: Number(trigger.payload.hour ?? 0),
            weekday: String(trigger.payload.weekday ?? ""),
            date: String(trigger.payload.date ?? "")
          }
        };
    }
  }

  private resetGraphActivationLevels(nextLevel: number): void {
    for (const node of this.input.graph.getAllNodes()) {
      this.input.graph.setActivationLevel(node.id, nextLevel);
    }
  }

  private buildConfigSnapshot(config: CognitionConfig): ActivationLogEntry["config_snapshot"] {
    return {
      spreading_factor: config.spreading.spreading_factor,
      retention_delta: config.spreading.retention_delta,
      temporal_decay_rho: config.spreading.temporal_decay_rho,
      diffusion_max_depth: config.spreading.diffusion_max_depth,
      spreading_size_limit: config.spreading.spreading_size_limit,
      hebbian_learning_rate: config.hebbian.learning_rate,
      passive_decay_rate: config.hebbian.passive_decay_rate,
      random_walk_probability: config.triggers.random_walk_probability,
      expression_activation_threshold: config.expression.activation_threshold,
      expression_cooldown_minutes: config.expression.cooldown_minutes,
      heartbeat_lambda_minutes: config.loop.heartbeat_lambda_minutes,
      duplicate_detection_threshold: config.graph_maintenance.duplicate_detection_threshold,
      max_edges_per_node: config.graph_maintenance.max_edges_per_node
    };
  }

  private async getRecentDialogue(): Promise<HistoryMessage[]> {
    const page = await this.input.memory.listHistoryByCursor({
      threadId: PRIMARY_THREAD_ID,
      resourceId: PRIMARY_RESOURCE_ID,
      limit: 5
    });
    return page.items;
  }
}
