import type { EdgeChange, HebbianConfig, HebbianUpdateLog } from "@shared/cognition";
import { mean } from "../utils/math";
import { MemoryGraphStore } from "./memory-graph";

export function applyHebbianLearning(
  graph: MemoryGraphStore,
  activationResult: Map<string, number>,
  config: Pick<HebbianConfig, "learning_rate" | "decay_lambda" | "normalization_cap" | "weight_min" | "weight_max">
): HebbianUpdateLog {
  const deltaByEdgeId = new Map<string, { delta: number; before: number }>();
  const changesByEdgeId = new Map<string, EdgeChange>();

  for (const edge of graph.getAllEdges()) {
    const sourceActivation = activationResult.get(edge.source);
    const targetActivation = activationResult.get(edge.target);
    if (sourceActivation === undefined || targetActivation === undefined) {
      continue;
    }

    const before = edge.weight;
    const delta = config.learning_rate * (sourceActivation * targetActivation - config.decay_lambda * before);
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

    edge.weight = Math.min(config.weight_max, Math.max(config.weight_min, before + delta));
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
    if (totalWeight <= config.normalization_cap || totalWeight <= 0) {
      continue;
    }

    const scale = config.normalization_cap / totalWeight;
    for (const edge of outEdges) {
      edge.weight *= scale;
      const existing = changesByEdgeId.get(edge.id);
      if (existing) {
        existing.weight_after = edge.weight;
      }
    }
    normalizationTriggeredNodes += 1;
  }

  const changes = [...changesByEdgeId.values()];
  const weights = graph.getAllEdges().map((edge) => edge.weight);
  const strengthenedChanges = [...changes]
    .filter((change) => change.delta > 0)
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .slice(0, 3);
  const weakenedChanges = [...changes]
    .filter((change) => change.delta < 0)
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .slice(0, 3);

  return {
    edges_updated: deltaByEdgeId.size,
    edges_strengthened: strengthened,
    edges_weakened: weakened,
    normalization_triggered_nodes: normalizationTriggeredNodes,
    max_weight_after: weights.length > 0 ? Math.max(...weights) : 0,
    min_weight_after: weights.length > 0 ? Math.min(...weights) : 0,
    avg_weight_after: mean(weights),
    top_strengthened: strengthenedChanges,
    top_weakened: weakenedChanges
  };
}
