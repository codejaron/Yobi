import type { ActivationPathLogRound, ActivationResult, SpreadingConfig } from "@shared/cognition";
import { MemoryGraphStore } from "../graph/memory-graph";

function computeTemporalDecayDays(sourceTs: number, targetTs: number): number {
  const deltaMs = Math.abs(sourceTs - targetTs);
  return deltaMs / (24 * 60 * 60 * 1000);
}

export function spread(
  graph: MemoryGraphStore,
  seeds: Array<{ nodeId: string; energy: number }>,
  config: SpreadingConfig
): ActivationResult {
  const activated = new Map<string, number>();
  const pathLog: ActivationPathLogRound[] = [];
  const initialFrontier = new Set<string>();

  for (const seed of seeds) {
    activated.set(seed.nodeId, seed.energy);
    graph.updateActivation(seed.nodeId, seed.energy);
    initialFrontier.add(seed.nodeId);
  }

  let frontier = initialFrontier;
  let totalVisited = seeds.length;

  for (let depth = 0; depth < config.diffusion_max_depth; depth += 1) {
    if (frontier.size === 0) {
      break;
    }

    const nextFrontier = new Map<string, number>();
    const retained: ActivationPathLogRound["retained"] = [];
    const propagated: ActivationPathLogRound["propagated"] = [];

    for (const sourceId of frontier) {
      const sourceNode = graph.getNode(sourceId);
      if (!sourceNode) {
        continue;
      }

      const sourceActivation = activated.get(sourceId) ?? 0;
      for (const neighbor of graph.getNeighbors(sourceId)) {
        const targetNode = neighbor.node;
        if (!targetNode) {
          continue;
        }

        let effectiveWeight = neighbor.edge.weight;
        if (neighbor.edge.relation_type === "temporal") {
          const deltaDays = computeTemporalDecayDays(sourceNode.created_at, targetNode.created_at);
          effectiveWeight *= Math.exp(-config.temporal_decay_rho * deltaDays);
        }

        const propagation = sourceActivation * effectiveWeight * config.spreading_factor;
        if (propagation <= 0) {
          continue;
        }

        nextFrontier.set(neighbor.target, (nextFrontier.get(neighbor.target) ?? 0) + propagation);
        propagated.push({
          from: sourceId,
          to: neighbor.target,
          activation: propagation,
          relation_type: neighbor.edge.relation_type
        });
      }
    }

    const remainingBudget = Math.max(0, config.spreading_size_limit - totalVisited);
    let frontierEntries = [...nextFrontier.entries()].sort((left, right) => right[1] - left[1]);
    if (frontierEntries.length > remainingBudget) {
      frontierEntries = frontierEntries.slice(0, remainingBudget);
    }

    const allowedTargets = new Set(frontierEntries.map(([nodeId]) => nodeId));

    for (const sourceId of frontier) {
      const nextValue = (activated.get(sourceId) ?? 0) * config.retention_delta;
      activated.set(sourceId, nextValue);
      graph.setActivationLevel(sourceId, nextValue);
      retained.push({
        node_id: sourceId,
        activation: nextValue
      });
    }

    for (const [targetId, value] of frontierEntries) {
      const nextValue = (activated.get(targetId) ?? 0) + value;
      activated.set(targetId, nextValue);
      graph.updateActivation(targetId, nextValue);
    }

    pathLog.push({
      depth: depth + 1,
      frontier: [...frontier].map((nodeId) => ({
        node_id: nodeId,
        activation: activated.get(nodeId) ?? 0
      })),
      retained,
      propagated: propagated.filter((entry) => allowedTargets.has(entry.to))
    });

    frontier = new Set(frontierEntries.map(([nodeId]) => nodeId));
    totalVisited += frontier.size;
  }

  return {
    activated,
    path_log: pathLog
  };
}
