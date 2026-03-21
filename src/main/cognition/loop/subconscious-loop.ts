import type { AppConfig, HistoryMessage } from "@shared/types";
import type { ActivationLogEntry, CognitionConfig } from "@shared/cognition";
import type { AppLogger } from "@main/services/logger";
import { appendJsonlLine } from "@main/storage/fs";
import type { ModelFactory } from "@main/core/model-factory";
import type { YobiMemory } from "@main/memory/setup";
import { spread } from "../activation/spreading-activation";
import { MemoryGraphStore } from "../graph/memory-graph";
import { ThoughtPool } from "../thoughts/thought-bubble";
import { evaluateAndExpress } from "../evaluation/expression-gate";
import { signalToSeeds, type CognitionSignal } from "./signal-to-seed";

const PRIMARY_RESOURCE_ID = "primary-user";
const PRIMARY_THREAD_ID = "primary-thread";
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

interface SubconsciousLoopInput {
  graph: MemoryGraphStore;
  thoughtPool: ThoughtPool;
  memory: Pick<YobiMemory, "embedText" | "getProfile" | "listHistoryByCursor">;
  modelFactory: ModelFactory;
  logger: AppLogger;
  paths: {
    cognitionActivationLogPath: string;
  };
  getAppConfig: () => AppConfig;
  getCognitionConfig: () => CognitionConfig;
  getUserOnline: () => boolean;
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
  }) => Promise<void> | void;
  onTickCompleted: (entry: ActivationLogEntry) => Promise<void> | void;
}

export class SubconsciousLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private readonly input: SubconsciousLoopInput) {}

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.scheduleNext(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<ActivationLogEntry> {
    const now = new Date();
    return this.runSignal({
      type: "time_signal",
      payload: {
        hour: now.getHours(),
        weekday: DAY_NAMES[now.getDay()],
        date: now.toISOString().slice(0, 10)
      }
    });
  }

  async triggerManualSpread(text: string): Promise<ActivationLogEntry> {
    return this.runSignal(
      {
        type: "manual_signal",
        payload: {
          text
        }
      },
      {
        forceUserOnline: true
      }
    );
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) {
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      void this.tick()
        .catch((error) => {
          this.input.logger.warn("cognition", "loop-tick-failed", undefined, error);
        })
        .finally(() => {
          if (!this.running) {
            return;
          }

          const lambdaMs = this.input.getCognitionConfig().loop.heartbeat_lambda_minutes * 60 * 1000;
          const nextDelay = -Math.log(1 - Math.random()) * lambdaMs;
          this.scheduleNext(nextDelay);
        });
    }, delayMs);
    this.timer.unref?.();
  }

  private async runSignal(
    signal: CognitionSignal,
    options: {
      forceUserOnline?: boolean;
    } = {}
  ): Promise<ActivationLogEntry> {
    const config = this.input.getCognitionConfig();
    const seeds = await signalToSeeds(signal, this.input.graph, (text) => this.input.memory.embedText(text));
    if (seeds.length === 0) {
      this.resetGraphActivationLevels(0);
      const emptyEntry: ActivationLogEntry = {
        timestamp: Date.now(),
        trigger_type: signal.type,
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
        manual_text: signal.type === "manual_signal" ? signal.payload.text : null,
        expression_reason: "no-seeds"
      };
      await this.recordTick(emptyEntry);
      return emptyEntry;
    }

    const nowMs = Date.now();
    for (const node of this.input.graph.getAllNodes()) {
      const baseLevel = this.input.graph.computeBaseLevelActivation(node.id, nowMs);
      this.input.graph.setActivationLevel(node.id, Number.isFinite(baseLevel) ? Math.max(0, baseLevel) : 0);
    }

    const activationResult = spread(this.input.graph, seeds, config.spreading);
    const rankedActivated = [...activationResult.activated.entries()]
      .sort((left, right) => right[1] - left[1]);
    const bubble = this.input.thoughtPool.createBubble(
      seeds.map((seed) => seed.nodeId),
      rankedActivated.map(([nodeId, activation]) => ({
        nodeId,
        activation,
        emotional_valence: this.input.graph.getNode(nodeId)?.emotional_valence ?? 0
      })),
      activationResult
    );
    this.input.thoughtPool.decayAll(0.92, [bubble.id]);

    const recentDialogue = await this.getRecentDialogue();
    const userProfile = await this.input.memory.getProfile();
    const candidates = this.input.thoughtPool.getBubbles()
      .filter((item) => item.status === "nascent" && item.activation_peak >= config.expression.activation_threshold)
      .sort((left, right) => right.activation_peak - left.activation_peak);

    let selectedReason = "bubble-created";
    let bubblePassedFilter = false;
    let expressionText: string | null = null;
    let bubbleSummary: string | null = bubble.summary || null;
    let evaluationScore: number | null = null;
    let evaluationDimensions: ActivationLogEntry["evaluation_dimensions"] = null;

    for (const candidate of candidates) {
      const evaluation = await evaluateAndExpress({
        bubble: candidate,
        thoughtPool: this.input.thoughtPool,
        recentDialogue,
        userProfile,
        modelFactory: this.input.modelFactory,
        appConfig: this.input.getAppConfig(),
        config,
        lastExpressionTime: this.input.getLastExpressionTime(),
        userOnline: options.forceUserOnline === true ? true : this.input.getUserOnline()
      });
      bubblePassedFilter = bubblePassedFilter || evaluation.bubblePassedFilter;
      bubbleSummary = evaluation.summary ?? bubbleSummary;
      evaluationScore = evaluation.evaluationScore;
      evaluationDimensions = evaluation.evaluationDimensions;
      selectedReason = evaluation.reason;

      if (!evaluation.text) {
        continue;
      }

      expressionText = evaluation.text;
      this.input.thoughtPool.markExpressed(candidate.id);
      this.input.setLastExpressionTime(Date.now());
      await this.input.onProactiveMessage({
        message: evaluation.text,
        metadata: {
          proactive: true,
          source: "yobi"
        },
        recordProactive: true
      });
      break;
    }

    const entry: ActivationLogEntry = {
      timestamp: nowMs,
      trigger_type: signal.type,
      seeds: seeds.map((seed) => ({
        node_id: seed.nodeId,
        label: this.input.graph.getNode(seed.nodeId)?.content ?? seed.nodeId
      })),
      top_activated: rankedActivated.slice(0, 10).map(([nodeId, activation]) => ({
        node_id: nodeId,
        label: this.input.graph.getNode(nodeId)?.content ?? nodeId,
        activation
      })),
      path_log: activationResult.path_log,
      hop_summaries: activationResult.path_log.map((round) => {
        const aggregated = new Map<string, number>();
        for (const item of round.propagated) {
          aggregated.set(item.to, (aggregated.get(item.to) ?? 0) + item.activation);
        }
        const nodes = [...aggregated.entries()]
          .sort((left, right) => right[1] - left[1])
          .slice(0, 3)
          .map(([nodeId, activation]) => ({
            node_id: nodeId,
            label: this.input.graph.getNode(nodeId)?.content ?? nodeId,
            activation
          }));
        return {
          depth: round.depth,
          nodes
        };
      }),
      config_snapshot: this.buildConfigSnapshot(config),
      activated_count: activationResult.activated.size,
      activation_peak: bubble.activation_peak,
      bubbles_generated: 1,
      bubble_passed_filter: bubblePassedFilter,
      expression_produced: Boolean(expressionText),
      expression_text: expressionText,
      bubble_id: bubble.id,
      bubble_summary: bubbleSummary,
      evaluation_score: evaluationScore,
      evaluation_dimensions: evaluationDimensions,
      manual_text: signal.type === "manual_signal" ? signal.payload.text : null,
      expression_reason: selectedReason
    };
    await this.recordTick(entry);
    return entry;
  }

  private resetGraphActivationLevels(nextLevel: number): void {
    for (const node of this.input.graph.getAllNodes()) {
      this.input.graph.setActivationLevel(node.id, nextLevel);
    }
  }

  private async recordTick(entry: ActivationLogEntry): Promise<void> {
    await appendJsonlLine(this.input.paths.cognitionActivationLogPath, entry);
    await Promise.resolve(this.input.onTickCompleted(entry));
  }

  private buildConfigSnapshot(config: CognitionConfig): ActivationLogEntry["config_snapshot"] {
    return {
      spreading_factor: config.spreading.spreading_factor,
      retention_delta: config.spreading.retention_delta,
      temporal_decay_rho: config.spreading.temporal_decay_rho,
      diffusion_max_depth: config.spreading.diffusion_max_depth,
      spreading_size_limit: config.spreading.spreading_size_limit,
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
