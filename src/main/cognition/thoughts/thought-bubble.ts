import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { CompanionPaths } from "@main/storage/paths";
import type { ActivationResult, ThoughtBubble, ThoughtPoolSnapshot } from "@shared/cognition";

interface BubbleActivationInput {
  nodeId: string;
  activation: number;
  emotional_valence?: number;
}

export class ThoughtPool {
  private bubbles: ThoughtBubble[] = [];
  private history: ThoughtBubble[] = [];

  constructor(private readonly paths: CompanionPaths) {}

  createBubble(
    seeds: string[],
    activatedNodes: BubbleActivationInput[],
    activationResult: ActivationResult
  ): ThoughtBubble {
    const topActivated = [...activatedNodes]
      .sort((left, right) => right.activation - left.activation)
      .slice(0, 10);
    const activationPeak = topActivated[0]?.activation ?? 0;
    const emotionalTotal = topActivated.reduce(
      (sum, item) => sum + (item.emotional_valence ?? 0) * item.activation,
      0
    );
    const activationTotal = topActivated.reduce((sum, item) => sum + item.activation, 0);
    const now = Date.now();

    const bubble: ThoughtBubble = {
      id: randomUUID(),
      summary: "",
      source_seeds: [...seeds],
      activated_nodes: topActivated.map((item) => ({
        node_id: item.nodeId,
        activation: item.activation
      })),
      activation_peak: activationPeak,
      emotional_tone: activationTotal > 0 ? emotionalTotal / activationTotal : 0,
      novelty_score: 1,
      created_at: now,
      last_reinforced_at: now,
      status: "nascent"
    };

    if (this.bubbles.length >= 5) {
      const [lowest] = [...this.bubbles].sort((left, right) => left.activation_peak - right.activation_peak);
      if (lowest) {
        this.bubbles = this.bubbles.filter((candidate) => candidate.id !== lowest.id);
        this.history.push(lowest);
      }
    }

    this.bubbles.push(bubble);
    this.persistState({
      action: "create",
      bubble,
      activated_count: activationResult.activated.size
    });
    return bubble;
  }

  matureBubble(bubbleId: string, summary: string): ThoughtBubble | null {
    const target = this.bubbles.find((bubble) => bubble.id === bubbleId);
    if (!target) {
      return null;
    }

    target.summary = summary.trim();
    target.status = "mature";
    target.last_reinforced_at = Date.now();
    this.persistState({
      action: "mature",
      bubble: target
    });
    return target;
  }

  markExpressed(bubbleId: string): ThoughtBubble | null {
    const target = this.bubbles.find((bubble) => bubble.id === bubbleId);
    if (!target) {
      return null;
    }

    target.status = "expressed";
    target.last_reinforced_at = Date.now();
    this.persistState({
      action: "express",
      bubble: target
    });
    return target;
  }

  decayAll(factor = 0.92, excludeBubbleIds: string[] = []): void {
    const excluded = new Set(excludeBubbleIds);
    const survivors: ThoughtBubble[] = [];
    for (const bubble of this.bubbles) {
      if (excluded.has(bubble.id)) {
        survivors.push(bubble);
        continue;
      }

      const nextPeak = bubble.activation_peak * factor;
      if (nextPeak < 0.05) {
        bubble.activation_peak = nextPeak;
        bubble.status = "decayed";
        bubble.last_reinforced_at = Date.now();
        this.history.push(bubble);
        continue;
      }

      bubble.activation_peak = nextPeak;
      bubble.last_reinforced_at = Date.now();
      survivors.push(bubble);
    }

    this.bubbles = survivors;
    this.persistState({
      action: "decay-all",
      active_count: this.bubbles.length
    });
  }

  getBubbles(): ThoughtBubble[] {
    return this.bubbles.map((bubble) => ({
      ...bubble,
      source_seeds: [...bubble.source_seeds],
      activated_nodes: bubble.activated_nodes.map((item) => ({ ...item }))
    }));
  }

  getMatureBubbles(): ThoughtBubble[] {
    return this.getBubbles().filter((bubble) => bubble.status === "mature");
  }

  toJSON(): ThoughtPoolSnapshot {
    return {
      bubbles: this.getBubbles(),
      history_count: this.history.length
    };
  }

  private persistState(payload: Record<string, unknown>): void {
    fs.mkdirSync(this.paths.cognitionDir, { recursive: true });
    fs.appendFileSync(
      this.paths.cognitionThoughtPoolPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        ...payload,
        state: this.toJSON()
      })}\n`,
      "utf8"
    );
  }
}
