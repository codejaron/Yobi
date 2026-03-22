import type {
  EdgeChange,
  HebbianBroadcastReport,
  HebbianConfig,
  HebbianUpdateLog,
  WorkspaceConfig
} from "@shared/cognition";
import { mean } from "../utils/math";
import { MemoryGraphStore } from "./memory-graph";

interface HebbianRunConfig {
  learningRate: number;
  decayLambda: number;
  normalizationCap: number;
  weightMin: number;
  weightMax: number;
}

interface HebbianRunResult {
  edgesUpdated: number;
  strengthened: number;
  weakened: number;
  normalizationTriggeredNodes: number;
  topStrengthened: EdgeChange[];
  topWeakened: EdgeChange[];
  weights: number[];
  effectiveDeltaByEdgeId: Map<string, number>;
}

function runHebbianUpdate(
  graph: MemoryGraphStore,
  activationResult: Map<string, number>,
  config: HebbianRunConfig
): HebbianRunResult {
  const deltaByEdgeId = new Map<string, { delta: number; before: number }>();
  const changesByEdgeId = new Map<string, EdgeChange>();

  for (const edge of graph.getAllEdges()) {
    const sourceActivation = activationResult.get(edge.source);
    const targetActivation = activationResult.get(edge.target);
    if (sourceActivation === undefined || targetActivation === undefined) {
      continue;
    }

    const before = edge.weight;
    const delta = config.learningRate * (sourceActivation * targetActivation - config.decayLambda * before);
    deltaByEdgeId.set(edge.id, {
      delta,
      before
    });
  }

  let strengthened = 0;
  let weakened = 0;
  const affectedSources = new Set<string>();

  for (const [edgeId, { delta, before }] of deltaByEdgeId.entries()) {
    const edge = graph.getEdgeById(edgeId);
    if (!edge) {
      continue;
    }

    edge.weight = Math.min(config.weightMax, Math.max(config.weightMin, before + delta));
    if (delta > 0) {
      strengthened += 1;
    } else if (delta < 0) {
      weakened += 1;
    }
    affectedSources.add(edge.source);

    changesByEdgeId.set(edge.id, {
      edge_id: edge.id,
      source_id: edge.source,
      target_id: edge.target,
      source_content: graph.getNode(edge.source)?.content ?? edge.source,
      target_content: graph.getNode(edge.target)?.content ?? edge.target,
      weight_before: before,
      weight_after: edge.weight,
      delta
    });
  }

  let normalizationTriggeredNodes = 0;
  for (const sourceId of affectedSources) {
    const outEdges = graph.getOutgoingEdges(sourceId);
    const totalWeight = outEdges.reduce((sum, edge) => sum + edge.weight, 0);
    if (totalWeight <= config.normalizationCap || totalWeight <= 0) {
      continue;
    }

    const scale = config.normalizationCap / totalWeight;
    for (const edge of outEdges) {
      edge.weight *= scale;
      const existing = changesByEdgeId.get(edge.id);
      if (existing) {
        existing.weight_after = edge.weight;
      }
    }
    normalizationTriggeredNodes += 1;
  }

  const effectiveDeltaByEdgeId = new Map<string, number>();
  for (const [edgeId, change] of changesByEdgeId.entries()) {
    effectiveDeltaByEdgeId.set(edgeId, change.weight_after - change.weight_before);
  }

  const changes = [...changesByEdgeId.values()];
  const weights = graph.getAllEdges().map((edge) => edge.weight);
  const topStrengthened = [...changes]
    .filter((change) => change.delta > 0)
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .slice(0, 3);
  const topWeakened = [...changes]
    .filter((change) => change.delta < 0)
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .slice(0, 3);

  return {
    edgesUpdated: deltaByEdgeId.size,
    strengthened,
    weakened,
    normalizationTriggeredNodes,
    topStrengthened,
    topWeakened,
    weights,
    effectiveDeltaByEdgeId
  };
}

export function applyHebbianLearning(
  graph: MemoryGraphStore,
  activationResult: Map<string, number>,
  config: Pick<HebbianConfig, "learning_rate" | "decay_lambda" | "normalization_cap" | "weight_min" | "weight_max">
): HebbianUpdateLog {
  const result = runHebbianUpdate(graph, activationResult, {
    learningRate: config.learning_rate,
    decayLambda: config.decay_lambda,
    normalizationCap: config.normalization_cap,
    weightMin: config.weight_min,
    weightMax: config.weight_max
  });

  return {
    edges_updated: result.edgesUpdated,
    edges_strengthened: result.strengthened,
    edges_weakened: result.weakened,
    normalization_triggered_nodes: result.normalizationTriggeredNodes,
    max_weight_after: result.weights.length > 0 ? Math.max(...result.weights) : 0,
    min_weight_after: result.weights.length > 0 ? Math.min(...result.weights) : 0,
    avg_weight_after: mean(result.weights),
    top_strengthened: result.topStrengthened,
    top_weakened: result.topWeakened
  };
}

export function applyBroadcastHebbian(
  graph: MemoryGraphStore,
  activationSnapshot: Map<string, number>,
  config: Pick<WorkspaceConfig, "broadcast_hebbian_rate" | "broadcast_hebbian_overlap_threshold"> &
    Pick<HebbianConfig, "decay_lambda" | "normalization_cap" | "weight_min" | "weight_max">,
  regularDeltaByEdgeId?: ReadonlyMap<string, number>
): HebbianBroadcastReport {
  const result = runHebbianUpdate(graph, activationSnapshot, {
    learningRate: config.broadcast_hebbian_rate,
    decayLambda: config.decay_lambda,
    normalizationCap: config.normalization_cap,
    weightMin: config.weight_min,
    weightMax: config.weight_max
  });

  let maxSingleTickDelta = 0;
  for (const [edgeId, broadcastDelta] of result.effectiveDeltaByEdgeId.entries()) {
    const regularDelta = regularDeltaByEdgeId?.get(edgeId) ?? 0;
    maxSingleTickDelta = Math.max(maxSingleTickDelta, Math.abs(regularDelta + broadcastDelta));
  }

  return {
    updated_edges_count: result.edgesUpdated,
    strengthened_count: result.strengthened,
    weakened_count: result.weakened,
    normalization_triggered_nodes: result.normalizationTriggeredNodes,
    max_single_tick_delta: maxSingleTickDelta,
    overlap_warning: maxSingleTickDelta > config.broadcast_hebbian_overlap_threshold,
    top_strengthened: result.topStrengthened,
    top_weakened: result.topWeakened
  };
}
