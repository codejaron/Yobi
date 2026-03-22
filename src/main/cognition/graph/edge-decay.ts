import type { EdgeDecayLog } from "@shared/cognition";
import { MemoryGraphStore } from "./memory-graph";

export function applyGlobalEdgeDecay(
  graph: MemoryGraphStore,
  config: {
    passive_decay_rate: number;
    weight_min: number;
  }
): EdgeDecayLog {
  let edgesDecayed = 0;
  let edgesAtMinimum = 0;

  for (const edge of graph.getAllEdges()) {
    if (edge.weight <= config.weight_min) {
      edgesAtMinimum += 1;
      continue;
    }

    edge.weight = Math.max(config.weight_min, edge.weight * (1 - config.passive_decay_rate));
    edgesDecayed += 1;

    if (edge.weight <= config.weight_min) {
      edgesAtMinimum += 1;
    }
  }

  return {
    edges_decayed: edgesDecayed,
    edges_at_minimum: edgesAtMinimum
  };
}
