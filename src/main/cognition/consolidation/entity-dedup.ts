import { randomUUID } from "node:crypto";
import { DEFAULT_COGNITION_CONFIG, type CognitionConfig, type ConsolidationMergedEntity, type MemoryNode } from "@shared/cognition";
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

function mergeStringSets(...values: Array<unknown>): string[] {
  const merged = new Set<string>();
  for (const value of values) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const item of value) {
      if (typeof item === "string" && item.trim()) {
        merged.add(item.trim());
      }
    }
  }
  return [...merged];
}

function neighborSet(graph: MemoryGraphStore, nodeId: string): Set<string> {
  const outgoing = graph.getOutgoingEdges(nodeId).map((edge) => edge.target);
  const incoming = graph.getIncomingEdges(nodeId).map((edge) => edge.source);
  return new Set([...outgoing, ...incoming].filter((candidate) => candidate !== nodeId));
}

function neighborOverlap(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) {
      intersection += 1;
    }
  }
  return intersection / Math.max(1, Math.min(left.size, right.size));
}

function mergeIntoTarget(input: {
  graph: MemoryGraphStore;
  source: MemoryNode;
  target: MemoryNode;
}): void {
  const nextTarget: MemoryNode = {
    ...input.target,
    activation_history: [...new Set([
      ...input.target.activation_history,
      ...input.source.activation_history
    ])].sort((a, b) => a - b),
    created_at: Math.min(input.source.created_at, input.target.created_at),
    last_activated_at: Math.max(input.source.last_activated_at, input.target.last_activated_at),
    metadata: {
      ...input.source.metadata,
      ...input.target.metadata,
      aliases: mergeStringSets(
        input.target.metadata.aliases,
        input.source.metadata.aliases,
        [input.source.content]
      ),
      reinforcement_count:
        (typeof input.target.metadata.reinforcement_count === "number"
          ? Number(input.target.metadata.reinforcement_count)
          : 0) +
        (typeof input.source.metadata.reinforcement_count === "number"
          ? Number(input.source.metadata.reinforcement_count)
          : 0)
    }
  };
  input.graph.replaceNode(nextTarget);

  const rewrittenEdges = input.graph
    .getAllEdges()
    .filter((edge) => edge.source === input.source.id || edge.target === input.source.id)
    .map((edge) => ({
      ...edge,
      source: edge.source === input.source.id ? input.target.id : edge.source,
      target: edge.target === input.source.id ? input.target.id : edge.target
    }));

  input.graph.removeNodes([input.source.id]);
  for (const edge of rewrittenEdges) {
    if (edge.source === edge.target) {
      continue;
    }
    const existing = input.graph.getEdgesBetween(edge.source, edge.target).find((candidate) => candidate.relation_type === edge.relation_type);
    if (existing) {
      input.graph.addEdge({
        ...existing,
        weight: Math.max(existing.weight, edge.weight)
      });
      continue;
    }
    input.graph.addEdge({
      ...edge,
      id: randomUUID()
    });
  }
}

export function dedupePersonEntities(input: {
  graph: MemoryGraphStore;
  cognitionConfig?: CognitionConfig;
}): { mergedEntities: ConsolidationMergedEntity[] } {
  const cognitionConfig = input.cognitionConfig ?? DEFAULT_COGNITION_CONFIG;
  const people = input.graph.getAllNodes().filter((node) => node.type === "person");
  const mergedEntities: ConsolidationMergedEntity[] = [];

  for (let index = 0; index < people.length; index += 1) {
    const target = input.graph.getNode(people[index]!.id);
    if (!target || target.type !== "person") {
      continue;
    }
    const targetNeighbors = neighborSet(input.graph, target.id);

    for (let inner = index + 1; inner < people.length; inner += 1) {
      const source = input.graph.getNode(people[inner]!.id);
      if (!source || source.type !== "person") {
        continue;
      }

      const similarity = cosineSimilarity(target.embedding, source.embedding);
      if (similarity < cognitionConfig.consolidation.entity_merge_embedding_threshold) {
        continue;
      }

      const overlap = neighborOverlap(targetNeighbors, neighborSet(input.graph, source.id));
      if (overlap < cognitionConfig.consolidation.entity_merge_neighbor_overlap) {
        continue;
      }

      mergedEntities.push({
        source_id: source.id,
        target_id: target.id,
        source_content: source.content,
        target_content: target.content,
        similarity,
        neighbor_overlap: overlap
      });
      mergeIntoTarget({
        graph: input.graph,
        source,
        target
      });
    }
  }

  return {
    mergedEntities
  };
}

