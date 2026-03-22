import {
  DEFAULT_COGNITION_CONFIG,
  type ActivationPathLogRound,
  type ActivationResult,
  type CognitionConfig,
  type EmotionConfig,
  type SpreadingConfig
} from "@shared/cognition";
import { computeEdgeWeight, computeFanFactor } from "./fan-effect";
import { applyLateralInhibition } from "./lateral-inhibition";
import { applySigmoidGate } from "./sigmoid-gate";
import { computeEmotionModulatedWeight } from "./emotion-modulation";
import { MemoryGraphStore } from "../graph/memory-graph";
import { EmotionStateManager } from "../workspace/emotion-state";

type SpreadRuntimeConfig =
  | SpreadingConfig
  | Pick<CognitionConfig, "spreading" | "inhibition" | "sigmoid">;

function sortActivationEntries(entries: Array<[string, number]>): Array<[string, number]> {
  return entries.sort((left, right) => {
    if (right[1] !== left[1]) {
      return right[1] - left[1];
    }
    return left[0].localeCompare(right[0]);
  });
}

function toActivationItems(values: Map<string, number>): Array<{ node_id: string; activation: number }> {
  return sortActivationEntries([...values.entries()]).map(([nodeId, activation]) => ({
    node_id: nodeId,
    activation
  }));
}

function trimActivationTotals(
  values: Map<string, number>,
  limit: number
): Map<string, number> {
  if (values.size <= limit) {
    return new Map(values);
  }

  const trimmed = sortActivationEntries([...values.entries()]).slice(0, limit);
  return new Map(trimmed);
}

function resolveSpreadConfig(config: SpreadRuntimeConfig): Pick<CognitionConfig, "spreading" | "inhibition" | "sigmoid"> {
  if ("spreading" in config) {
    return config;
  }

  return {
    spreading: config,
    inhibition: DEFAULT_COGNITION_CONFIG.inhibition,
    sigmoid: DEFAULT_COGNITION_CONFIG.sigmoid
  };
}

// SYNAPSE formula 2 is usually written in pull form: each target i sums energy
// from incoming neighbors j. This implementation uses the equivalent push form:
// each active source j pushes energy across its outgoing edges to target i.
// Both compute the same total S * w_ji * a_j / fan(j), but push mode lets us
// iterate only over the currently active frontier instead of the whole graph.
export function spread(
  graph: MemoryGraphStore,
  seeds: Array<{ nodeId: string; energy: number }>,
  config: SpreadRuntimeConfig,
  options?: {
    emotionState?: EmotionStateManager | null;
    emotionConfig?: EmotionConfig;
    overrideConfig?: Partial<SpreadingConfig>;
  }
): ActivationResult {
  const runtimeConfig = resolveSpreadConfig(config);
  const spreadingConfig = {
    ...runtimeConfig.spreading,
    ...(options?.overrideConfig ?? {})
  };
  const emotionConfig = options?.emotionConfig ?? DEFAULT_COGNITION_CONFIG.emotion;
  const activated = new Map<string, number>();
  const pathLog: ActivationPathLogRound[] = [];
  const initialFrontier = new Set<string>();

  for (const seed of seeds) {
    activated.set(seed.nodeId, seed.energy);
    graph.updateActivation(seed.nodeId, seed.energy);
    initialFrontier.add(seed.nodeId);
  }

  let frontier = initialFrontier;

  for (let depth = 0; depth < spreadingConfig.diffusion_max_depth; depth += 1) {
    if (frontier.size === 0) {
      break;
    }

    const frontierSnapshot = [...frontier].map((nodeId) => ({
      node_id: nodeId,
      activation: activated.get(nodeId) ?? 0
    }));
    const retained: ActivationPathLogRound["retained"] = [];
    const propagated: ActivationPathLogRound["propagated"] = [];
    const propagationTotals = new Map<string, number>();

    for (const sourceId of frontier) {
      const sourceNode = graph.getNode(sourceId);
      if (!sourceNode) {
        continue;
      }

      const sourceActivation = activated.get(sourceId) ?? 0;
      const fanFactor = computeFanFactor(graph, sourceId);
      if (fanFactor <= 0) {
        continue;
      }

      for (const neighbor of graph.getNeighbors(sourceId)) {
        const targetNode = neighbor.node;
        if (!targetNode || neighbor.target === sourceId) {
          continue;
        }

        const effectiveWeight = computeEdgeWeight({
          sourceNode,
          targetNode,
          edge: neighbor.edge,
          temporalDecayRho: spreadingConfig.temporal_decay_rho
        });
        const modulatedWeight = options?.emotionState
          ? computeEmotionModulatedWeight(
              effectiveWeight,
              targetNode.emotional_valence,
              options.emotionState,
              emotionConfig
            )
          : effectiveWeight;
        const propagation = sourceActivation * spreadingConfig.spreading_factor * modulatedWeight / fanFactor;
        if (propagation <= 0) {
          continue;
        }

        propagationTotals.set(neighbor.target, (propagationTotals.get(neighbor.target) ?? 0) + propagation);
        propagated.push({
          from: sourceId,
          to: neighbor.target,
          activation: propagation,
          relation_type: neighbor.edge.relation_type
        });
      }
    }

    for (const sourceId of frontier) {
      const nextValue = (activated.get(sourceId) ?? 0) * spreadingConfig.retention_delta;
      activated.set(sourceId, nextValue);
      graph.setActivationLevel(sourceId, nextValue);
      retained.push({
        node_id: sourceId,
        activation: nextValue
      });
    }

    const inhibitionResult = applyLateralInhibition(propagationTotals, runtimeConfig.inhibition);
    const gatedTotals = applySigmoidGate(inhibitionResult.totals, runtimeConfig.sigmoid);
    const trimmedTotals = gatedTotals.size > spreadingConfig.spreading_size_limit
      ? trimActivationTotals(gatedTotals, spreadingConfig.spreading_size_limit)
      : null;
    const finalRoundTotals = trimmedTotals ?? gatedTotals;
    const survivingTargets = new Set(finalRoundTotals.keys());

    for (const [targetId, value] of finalRoundTotals.entries()) {
      const nextValue = (activated.get(targetId) ?? 0) + value;
      activated.set(targetId, nextValue);
      graph.updateActivation(targetId, nextValue);
    }

    pathLog.push({
      depth: depth + 1,
      frontier: frontierSnapshot,
      retained,
      propagated: propagated.filter((entry) => survivingTargets.has(entry.to)),
      propagation_totals: toActivationItems(propagationTotals),
      inhibition_winners: inhibitionResult.winners,
      inhibited_totals: toActivationItems(inhibitionResult.totals),
      gated_totals: toActivationItems(gatedTotals),
      trimmed_totals: trimmedTotals ? toActivationItems(trimmedTotals) : undefined
    });

    frontier = new Set(finalRoundTotals.keys());
  }

  return {
    activated,
    path_log: pathLog
  };
}
