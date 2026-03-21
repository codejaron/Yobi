import type { CognitionConfig } from "@shared/cognition";

type InhibitionConfig = CognitionConfig["inhibition"];

export interface LateralInhibitionResult {
  winners: Array<{ node_id: string; activation: number }>;
  totals: Map<string, number>;
}

function sortActivationEntries(entries: Array<[string, number]>): Array<[string, number]> {
  return entries.sort((left, right) => {
    if (right[1] !== left[1]) {
      return right[1] - left[1];
    }
    return left[0].localeCompare(right[0]);
  });
}

export function applyLateralInhibition(
  totals: Map<string, number>,
  config: InhibitionConfig
): LateralInhibitionResult {
  const sorted = sortActivationEntries([...totals.entries()]);
  const winnerEntries = sorted.slice(0, Math.max(0, config.lateral_inhibition_top_M));
  const winnerIds = new Set(winnerEntries.map(([nodeId]) => nodeId));
  const winnerSum = winnerEntries.reduce((sum, [, activation]) => sum + activation, 0);
  const inhibited = new Map<string, number>();

  for (const [nodeId, activation] of sorted) {
    if (winnerIds.has(nodeId)) {
      inhibited.set(nodeId, activation);
      continue;
    }
    inhibited.set(nodeId, Math.max(0, activation - config.lateral_inhibition_beta * winnerSum));
  }

  return {
    winners: winnerEntries.map(([nodeId, activation]) => ({
      node_id: nodeId,
      activation
    })),
    totals: inhibited
  };
}
