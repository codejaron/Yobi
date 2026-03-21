import type { CognitionConfig, ThoughtBubble } from "@shared/cognition";

export function roughFilter(
  bubble: ThoughtBubble,
  lastExpressionTime: number,
  userOnline: boolean,
  config: CognitionConfig
): boolean {
  const cooldownMs = config.expression.cooldown_minutes * 60 * 1000;
  return (
    bubble.activation_peak >= config.expression.activation_threshold &&
    bubble.novelty_score > 0 &&
    Date.now() - lastExpressionTime >= cooldownMs &&
    userOnline === true
  );
}
