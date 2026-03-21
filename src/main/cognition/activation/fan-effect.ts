import type { MemoryEdge, MemoryNode } from "@shared/cognition";
import { MemoryGraphStore } from "../graph/memory-graph";

function computeTemporalDecayDays(sourceTs: number, targetTs: number): number {
  const deltaMs = Math.abs(sourceTs - targetTs);
  return deltaMs / (24 * 60 * 60 * 1000);
}

export function computeFanFactor(graph: MemoryGraphStore, sourceId: string): number {
  return graph.getNeighbors(sourceId)
    .filter((neighbor) => neighbor.target !== sourceId && neighbor.node)
    .length;
}

export function computeEdgeWeight(input: {
  sourceNode: MemoryNode;
  targetNode: MemoryNode;
  edge: MemoryEdge;
  temporalDecayRho: number;
}): number {
  const { sourceNode, targetNode, edge, temporalDecayRho } = input;
  if (edge.relation_type !== "temporal") {
    return edge.weight;
  }

  const deltaDays = computeTemporalDecayDays(sourceNode.created_at, targetNode.created_at);

  // SYNAPSE defines temporal weights as exp(-rho * |delta_t|). We multiply that
  // by edge.weight so Hebbian learning can strengthen temporal links as well.
  // When edge.weight === 1, this reduces to the original paper formulation.
  return edge.weight * Math.exp(-temporalDecayRho * deltaDays);
}
