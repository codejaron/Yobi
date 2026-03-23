import { DEFAULT_COGNITION_CONFIG, type CognitionConfig, type MemoryNode } from "@shared/cognition";
import { computeEdgeWeight, computeFanFactor } from "../activation/fan-effect";
import { applyLateralInhibition } from "../activation/lateral-inhibition";
import { applySigmoidGate } from "../activation/sigmoid-gate";
import { MemoryGraphStore } from "../graph/memory-graph";

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
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

function sortScores<T extends { score: number }>(values: T[]): T[] {
  return values.sort((left, right) => right.score - left.score);
}

function trimActivationTotals(
  values: Map<string, number>,
  limit: number
): Map<string, number> {
  if (values.size <= limit) {
    return new Map(values);
  }

  return new Map(
    [...values.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit)
  );
}

function collectTopNodes(graph: MemoryGraphStore, activated: Map<string, number>, limit: number): MemoryNode[] {
  return [...activated.entries()]
    .map(([nodeId, score]) => ({
      node: graph.getNode(nodeId),
      score
    }))
    .filter((entry): entry is { node: MemoryNode; score: number } => entry.node !== undefined)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => entry.node);
}

function shallowSpread(input: {
  graph: MemoryGraphStore;
  seeds: Array<{ nodeId: string; energy: number }>;
  cognitionConfig: CognitionConfig;
}): Map<string, number> {
  const activated = new Map<string, number>();
  const spreadingConfig = input.cognitionConfig.spreading;

  for (const seed of input.seeds) {
    activated.set(seed.nodeId, seed.energy);
  }

  let frontier = new Set(input.seeds.map((seed) => seed.nodeId));
  for (let depth = 0; depth < input.cognitionConfig.retrieval.spread_depth; depth += 1) {
    if (frontier.size === 0) {
      break;
    }

    const propagationTotals = new Map<string, number>();
    for (const sourceId of frontier) {
      const sourceNode = input.graph.getNode(sourceId);
      if (!sourceNode) {
        continue;
      }
      const sourceActivation = activated.get(sourceId) ?? 0;
      const fanFactor = computeFanFactor(input.graph, sourceId);
      if (fanFactor <= 0) {
        continue;
      }

      for (const neighbor of input.graph.getNeighbors(sourceId)) {
        if (!neighbor.node || neighbor.target === sourceId) {
          continue;
        }
        const weight = computeEdgeWeight({
          sourceNode,
          targetNode: neighbor.node,
          edge: neighbor.edge,
          temporalDecayRho: spreadingConfig.temporal_decay_rho
        });
        const propagated = sourceActivation * spreadingConfig.spreading_factor * weight / fanFactor;
        if (propagated <= 0) {
          continue;
        }
        propagationTotals.set(neighbor.target, (propagationTotals.get(neighbor.target) ?? 0) + propagated);
      }
    }

    for (const sourceId of frontier) {
      const retained = (activated.get(sourceId) ?? 0) * spreadingConfig.retention_delta;
      activated.set(sourceId, retained);
    }

    const inhibition = applyLateralInhibition(propagationTotals, input.cognitionConfig.inhibition);
    const gated = applySigmoidGate(inhibition.totals, input.cognitionConfig.sigmoid);
    const trimmed = trimActivationTotals(gated, input.cognitionConfig.retrieval.result_top_k);
    for (const [nodeId, score] of trimmed.entries()) {
      activated.set(nodeId, (activated.get(nodeId) ?? 0) + score);
    }
    frontier = new Set(trimmed.keys());
  }

  return activated;
}

export async function buildReplyMemoryBlock(input: {
  graph: MemoryGraphStore;
  userText: string;
  embedText: (text: string) => Promise<number[] | null>;
  getRecentDialogueMessages: () => Promise<string[]>;
  cognitionConfig?: CognitionConfig;
}): Promise<string> {
  const cognitionConfig = input.cognitionConfig ?? DEFAULT_COGNITION_CONFIG;
  const normalizedText = input.userText.trim();
  if (!normalizedText) {
    return "";
  }

  const queryEmbedding = await input.embedText(normalizedText);
  if (!queryEmbedding || queryEmbedding.length === 0) {
    return "";
  }

  const seeds = sortScores(
    input.graph.getAllNodes().map((node) => ({
      node,
      score: Math.max(0, cosineSimilarity(queryEmbedding, node.embedding))
    }))
  )
    .slice(0, cognitionConfig.retrieval.seed_top_k)
    .filter((entry) => entry.score > 0)
    .map((entry) => ({
      nodeId: entry.node.id,
      energy: entry.score
    }));
  if (seeds.length === 0) {
    return "";
  }

  const activated = shallowSpread({
    graph: input.graph,
    seeds,
    cognitionConfig
  });

  const recentMessages = (await input.getRecentDialogueMessages())
    .map((message) => message.trim())
    .filter(Boolean)
    .slice(-(cognitionConfig.retrieval.dedup_lookback_turns * 2));
  const recentEmbeddings = await Promise.all(recentMessages.map((message) => input.embedText(message)));
  const filtered = collectTopNodes(input.graph, activated, cognitionConfig.retrieval.result_top_k)
    .filter((node) => !cognitionConfig.retrieval.excluded_node_types.includes(node.type))
    .filter((node) => recentEmbeddings.every((embedding) => {
      if (!embedding || embedding.length === 0) {
        return true;
      }
      return cosineSimilarity(node.embedding, embedding) <= cognitionConfig.retrieval.dedup_cosine_threshold;
    }))
    .slice(0, cognitionConfig.retrieval.final_top_k);

  if (filtered.length === 0) {
    return "";
  }

  return [
    "[你对这个用户的记忆]",
    ...filtered.map((node) => `- ${node.content}`)
  ].join("\n");
}

