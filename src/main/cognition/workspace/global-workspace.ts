import type {
  BroadcastPacket,
  BroadcastResult,
  BroadcastSummary,
  CognitionConfig,
  ThoughtBubble
} from "@shared/cognition";
import type { AppLogger } from "@main/services/logger";
import { applyBroadcastHebbian } from "../graph/hebbian-learning";
import { MemoryGraphStore } from "../graph/memory-graph";
import { EmotionStateManager } from "./emotion-state";
import { PredictionEngine } from "../activation/prediction-coding";
import { AttentionSchema } from "./attention-schema";

interface GlobalWorkspaceInput {
  graph: MemoryGraphStore;
  emotionState: EmotionStateManager;
  predictionEngine: PredictionEngine;
  attentionSchema: AttentionSchema;
  logger: Pick<AppLogger, "warn">;
  getCognitionConfig: () => CognitionConfig;
}

interface BroadcastCallInput {
  selectedBubble: ThoughtBubble;
  rawActivationResult: Map<string, number>;
  allNodeIds: string[];
  currentTickId: number;
  regularDeltaByEdgeId?: ReadonlyMap<string, number>;
}

function sortActivationEntries(entries: Array<[string, number]>): Array<[string, number]> {
  return entries.sort((left, right) => {
    if (right[1] !== left[1]) {
      return right[1] - left[1];
    }
    return left[0].localeCompare(right[0]);
  });
}

export class GlobalWorkspace {
  private history: BroadcastSummary[] = [];
  private broadcastCounter = 0;

  constructor(private readonly input: GlobalWorkspaceInput) {}

  hydrateHistory(summaries: BroadcastSummary[]): void {
    const maxItems = this.input.getCognitionConfig().workspace.broadcast_history_max;
    this.history = summaries.slice(-maxItems).map((summary) => ({ ...summary, modules_updated: [...summary.modules_updated] }));
    this.broadcastCounter = this.history.length;
  }

  getBroadcastHistory(): BroadcastSummary[] {
    return this.history.map((item) => ({
      ...item,
      modules_updated: [...item.modules_updated]
    }));
  }

  broadcast(input: BroadcastCallInput): BroadcastResult {
    const packet = this.buildBroadcastPacket(input.selectedBubble, input.rawActivationResult);
    const config = this.input.getCognitionConfig();
    const errors: Array<{ module_name: string; message: string }> = [];

    let hebbianReport: BroadcastResult["hebbian_report"] = null;
    try {
      const snapshotMap = new Map(packet.activation_snapshot.map((item) => [item.node_id, item.activation]));
      hebbianReport = applyBroadcastHebbian(
        this.input.graph,
        snapshotMap,
        {
          broadcast_hebbian_rate: config.workspace.broadcast_hebbian_rate,
          broadcast_hebbian_overlap_threshold: config.workspace.broadcast_hebbian_overlap_threshold,
          decay_lambda: config.hebbian.decay_lambda,
          normalization_cap: config.hebbian.normalization_cap,
          weight_min: config.hebbian.weight_min,
          weight_max: config.hebbian.weight_max
        },
        input.regularDeltaByEdgeId
      );
      this.updateReinforcementMetadata(input.selectedBubble);
      if (hebbianReport.overlap_warning) {
        this.input.logger.warn("cognition", "broadcast_hebbian_overlap_warning", {
          broadcast_id: packet.broadcast_id,
          max_single_tick_delta: hebbianReport.max_single_tick_delta
        });
      }
    } catch (error) {
      errors.push({
        module_name: "hebbian",
        message: error instanceof Error ? error.message : String(error)
      });
      this.input.logger.warn("cognition", "broadcast-hebbian-failed", {
        broadcast_id: packet.broadcast_id
      }, error);
    }

    let emotionReport: BroadcastResult["emotion_report"] = null;
    try {
      const before = this.input.emotionState.getSnapshot();
      const after = this.input.emotionState.updateFromBubble(
        input.selectedBubble,
        config.workspace.broadcast_emotion_alpha
      );
      emotionReport = {
        module_name: "emotion",
        success: true,
        details: {
          before_valence: before.valence,
          after_valence: after.valence,
          before_arousal: before.arousal,
          after_arousal: after.arousal
        }
      };
    } catch (error) {
      errors.push({
        module_name: "emotion",
        message: error instanceof Error ? error.message : String(error)
      });
      this.input.logger.warn("cognition", "broadcast-emotion-failed", {
        broadcast_id: packet.broadcast_id
      }, error);
    }

    let predictionReport: BroadcastResult["prediction_report"] = null;
    try {
      const beforeLength = this.input.predictionEngine.getWarmupProgress();
      const snapshotMap = new Map(packet.activation_snapshot.map((item) => [item.node_id, item.activation]));
      this.input.predictionEngine.integrateSuccessfulBroadcast(
        snapshotMap,
        input.allNodeIds,
        config.workspace.broadcast_prediction_weight,
        input.currentTickId
      );
      predictionReport = {
        module_name: "prediction",
        success: true,
        details: {
          history_progress_before: beforeLength,
          history_progress_after: this.input.predictionEngine.getWarmupProgress(),
          weight: config.workspace.broadcast_prediction_weight
        }
      };
    } catch (error) {
      errors.push({
        module_name: "prediction",
        message: error instanceof Error ? error.message : String(error)
      });
      this.input.logger.warn("cognition", "broadcast-prediction-failed", {
        broadcast_id: packet.broadcast_id
      }, error);
    }

    let attentionReport: BroadcastResult["attention_report"] = null;
    try {
      const state = this.input.attentionSchema.updateFromBroadcast(input.selectedBubble);
      attentionReport = {
        module_name: "attention",
        success: true,
        details: {
          focus_node_ids: state.focus_node_ids
        }
      };
    } catch (error) {
      errors.push({
        module_name: "attention",
        message: error instanceof Error ? error.message : String(error)
      });
      this.input.logger.warn("cognition", "broadcast-attention-failed", {
        broadcast_id: packet.broadcast_id
      }, error);
    }

    const result: BroadcastResult = {
      broadcast_id: packet.broadcast_id,
      packet,
      hebbian_report: hebbianReport,
      emotion_report: emotionReport,
      prediction_report: predictionReport,
      attention_report: attentionReport,
      errors
    };

    this.pushSummary({
      broadcast_id: packet.broadcast_id,
      timestamp: packet.timestamp,
      bubble_id: input.selectedBubble.id,
      bubble_summary: input.selectedBubble.summary || input.selectedBubble.id,
      modules_updated: [
        ...(hebbianReport ? ["hebbian"] : []),
        ...(emotionReport ? ["emotion"] : []),
        ...(predictionReport ? ["prediction"] : []),
        ...(attentionReport ? ["attention"] : [])
      ],
      has_errors: errors.length > 0,
      overlap_warning: hebbianReport?.overlap_warning ?? false
    });

    return result;
  }

  private buildBroadcastPacket(
    selectedBubble: ThoughtBubble,
    rawActivationResult: Map<string, number>
  ): BroadcastPacket {
    const config = this.input.getCognitionConfig();
    const timestamp = Date.now();
    const activation_snapshot = sortActivationEntries([...rawActivationResult.entries()])
      .slice(0, config.workspace.broadcast_snapshot_top_n)
      .map(([node_id, activation]) => ({
        node_id,
        activation
      }));
    const emotion = this.input.emotionState.getSnapshot();
    this.broadcastCounter += 1;

    return {
      broadcast_id: `${timestamp}-${this.broadcastCounter}`,
      timestamp,
      selected_bubble: {
        ...selectedBubble,
        source_seeds: [...selectedBubble.source_seeds],
        activated_nodes: selectedBubble.activated_nodes.map((node) => ({ ...node }))
      },
      activation_snapshot,
      emotion_at_broadcast: {
        valence: emotion.valence,
        arousal: emotion.arousal
      }
    };
  }

  private updateReinforcementMetadata(selectedBubble: ThoughtBubble): void {
    const now = Date.now();
    const reinforcedIds = new Set(selectedBubble.source_seeds);
    for (const nodeId of reinforcedIds) {
      const node = this.input.graph.getNode(nodeId);
      if (!node) {
        continue;
      }
      const currentCount = typeof node.metadata.reinforcement_count === "number"
        ? Number(node.metadata.reinforcement_count)
        : 0;
      this.input.graph.replaceNode({
        ...node,
        metadata: {
          ...node.metadata,
          reinforcement_count: currentCount + 1,
          last_reinforced_at: now
        }
      });
    }
  }

  private pushSummary(summary: BroadcastSummary): void {
    const maxItems = this.input.getCognitionConfig().workspace.broadcast_history_max;
    this.history.push(summary);
    if (this.history.length > maxItems) {
      this.history = this.history.slice(-maxItems);
    }
  }
}
