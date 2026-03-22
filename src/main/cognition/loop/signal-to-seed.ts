import type { ActrConfig } from "@shared/cognition";
import { MemoryGraphStore } from "../graph/memory-graph";
import type { ColdArchive } from "../consolidation/cold-archive";

const MANUAL_SEED_SIMILARITY_THRESHOLD = 0.55;
const MANUAL_SEED_TYPE_WEIGHT: Record<string, number> = {
  time_marker: 0.7
};

interface TimeSignalPayload {
  hour: number;
  weekday: string;
  date: string;
}

interface ManualSignalPayload {
  text: string;
}

interface DialogueResiduePayload {
  text: string;
}

interface SilenceSignalPayload {
  duration_minutes: number;
}

interface RandomWalkPayload {
  node_id: string;
  node_content?: string;
}

interface LowActivationRescuePayload {
  node_ids: string[];
}

export type CognitionSignal =
  | { type: "time_signal"; payload: TimeSignalPayload }
  | { type: "manual_signal"; payload: ManualSignalPayload }
  | { type: "dialogue_residue"; payload: DialogueResiduePayload }
  | { type: "silence"; payload: SilenceSignalPayload }
  | { type: "random_walk"; payload: RandomWalkPayload }
  | { type: "low_activation_rescue"; payload: LowActivationRescuePayload };

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  if (left.length !== right.length) {
    return 0;
  }

  const length = left.length;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm <= 0 || rightNorm <= 0) {
    return 0;
  }

  return dot / Math.sqrt(leftNorm * rightNorm);
}

function isHourMatch(content: string, hour: number): boolean {
  if (content.includes("中午")) {
    return hour >= 11 && hour <= 13;
  }
  if (content.includes("早上") || content.includes("上午")) {
    return hour >= 6 && hour <= 11;
  }
  if (content.includes("下午")) {
    return hour >= 13 && hour <= 18;
  }
  if (content.includes("晚上")) {
    return hour >= 18 && hour <= 23;
  }
  return false;
}

function weekdayAliases(weekday: string): string[] {
  const normalized = weekday.toLowerCase();
  const aliases: Record<string, string[]> = {
    sunday: ["sunday", "星期日", "星期天", "周日"],
    monday: ["monday", "星期一", "周一"],
    tuesday: ["tuesday", "星期二", "周二"],
    wednesday: ["wednesday", "星期三", "周三"],
    thursday: ["thursday", "星期四", "周四"],
    friday: ["friday", "星期五", "周五"],
    saturday: ["saturday", "星期六", "周六"]
  };
  return aliases[normalized] ?? [normalized];
}

export async function signalToSeeds(
  signal: CognitionSignal,
  graph: MemoryGraphStore,
  embedText: (text: string) => Promise<number[] | null>,
  options: {
    actr: ActrConfig;
    nowMs?: number;
    coldArchive?: ColdArchive;
  } = {
    actr: {
      decay_d: 0.5,
      base_level_scale: 0.1
    }
  }
): Promise<Array<{ nodeId: string; energy: number }>> {
  const recalled = options.coldArchive?.consumePendingRecall() ?? null;
  const recalledSeeds: Array<{ nodeId: string; energy: number }> = [];
  if (recalled) {
    graph.addNode(recalled.node);
    for (const edge of recalled.edges) {
      if (graph.getNode(edge.source) && graph.getNode(edge.target)) {
        graph.addEdge(edge);
      }
    }
    recalledSeeds.push({
      nodeId: recalled.node.id,
      energy: 0.7
    });
  }

  const nodes = graph.getAllNodes();
  if (nodes.length === 0) {
    return recalledSeeds;
  }

  if (signal.type === "time_signal") {
    const weekdayMatches = weekdayAliases(signal.payload.weekday);
    return [...recalledSeeds, ...nodes
      .filter((node) => node.type === "time_marker")
      .filter((node) => {
        const content = node.content.toLowerCase();
        return (
          isHourMatch(node.content, signal.payload.hour) ||
          weekdayMatches.some((match) => content.includes(match.toLowerCase()))
        );
      })
      .map((node) => ({
        nodeId: node.id,
        energy: 1
      }))];
  }

  let seeds: Array<{ nodeId: string; energy: number }> = [];

  if (signal.type === "manual_signal") {
    const text = signal.payload.text.trim();
    if (!text) {
      return recalledSeeds;
    }

    const queryEmbedding = await embedText(text);
    if (!queryEmbedding || queryEmbedding.length === 0) {
      return recalledSeeds;
    }

    seeds = nodes
      .map((node) => ({
        nodeId: node.id,
        energy: cosineSimilarity(queryEmbedding, node.embedding) * (MANUAL_SEED_TYPE_WEIGHT[node.type] ?? 1)
      }))
      .filter((item) => item.energy >= MANUAL_SEED_SIMILARITY_THRESHOLD)
      .sort((left, right) => {
        if (right.energy !== left.energy) {
          return right.energy - left.energy;
        }
        return left.nodeId.localeCompare(right.nodeId);
      })
      .slice(0, 3);
    if (seeds.length < 3) {
      options.coldArchive?.requestAsyncRecall(queryEmbedding);
    }
  } else if (signal.type === "dialogue_residue") {
    const text = signal.payload.text.trim();
    if (!text) {
      return recalledSeeds;
    }

    const queryEmbedding = await embedText(text);
    if (!queryEmbedding || queryEmbedding.length === 0) {
      return recalledSeeds;
    }

    seeds = graph.findByEmbeddingSimilarity(queryEmbedding, 3).map((node) => ({
      nodeId: node.id,
      energy: 0.8
    }));
    if (seeds.length < 3) {
      options.coldArchive?.requestAsyncRecall(queryEmbedding);
    }
  } else if (signal.type === "silence") {
    const nowMs = options.nowMs ?? Date.now();
    const candidateIds = nodes
      .filter((node) => node.activation_level < 0.1)
      .filter((node) => node.activation_history.some((timestamp) => nowMs - timestamp <= 30 * 24 * 60 * 60 * 1000))
      .map((node) => node.id);
    seeds = graph.getTopByBaseLevel({
      limit: 3,
      nowMs,
      decayD: options.actr.decay_d,
      candidateIds,
      minHistoryLength: 1
    }).map((node) => ({
      nodeId: node.id,
      energy: 0.6
    }));
  } else if (signal.type === "random_walk") {
    seeds = [{
      nodeId: signal.payload.node_id,
      energy: 0.5
    }];
  } else if (signal.type === "low_activation_rescue") {
    seeds = signal.payload.node_ids.map((nodeId) => ({
      nodeId,
      energy: 1
    }));
  }

  const nowMs = options.nowMs ?? Date.now();
  for (const seed of seeds) {
    const node = graph.getNode(seed.nodeId);
    if (!node) {
      continue;
    }
    const baseLevel = graph.computeBaseLevelActivation(seed.nodeId, nowMs, options.actr.decay_d);
    const baseBonus = Math.max(0, baseLevel * options.actr.base_level_scale);
    seed.energy += baseBonus;
  }

  return [...recalledSeeds, ...seeds]
    .filter((seed) => graph.getNode(seed.nodeId))
    .sort((left, right) => {
      if (right.energy !== left.energy) {
        return right.energy - left.energy;
      }
      return left.nodeId.localeCompare(right.nodeId);
    });
}
