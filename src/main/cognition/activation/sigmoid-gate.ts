import type { CognitionConfig } from "@shared/cognition";

type SigmoidConfig = CognitionConfig["sigmoid"];

export function applySigmoidGate(
  totals: Map<string, number>,
  config: SigmoidConfig
): Map<string, number> {
  const next = new Map<string, number>();

  for (const [nodeId, activation] of totals.entries()) {
    const gated = 1 / (1 + Math.exp(-config.gamma * (activation - config.theta)));
    if (gated < 0.001) {
      continue;
    }
    next.set(nodeId, gated);
  }

  return next;
}
