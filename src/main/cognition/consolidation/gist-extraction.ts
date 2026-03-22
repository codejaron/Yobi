import { randomUUID } from "node:crypto";
import type { CognitionConfig, MemoryEdge, MemoryNode } from "@shared/cognition";
import { MemoryGraphStore } from "../graph/memory-graph";
import type { GistReport } from "./types";

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

function meanEmbedding(nodes: MemoryNode[]): number[] {
  const length = nodes[0]?.embedding.length ?? 0;
  if (length === 0 || nodes.length === 0) {
    return [];
  }
  const values = new Array<number>(length).fill(0);
  for (const node of nodes) {
    for (let index = 0; index < length; index += 1) {
      values[index] = (values[index] ?? 0) + (node.embedding[index] ?? 0);
    }
  }
  return values.map((value) => value / nodes.length);
}

interface GistExtractorInput {
  graph: MemoryGraphStore;
  getCognitionConfig: () => CognitionConfig;
  summarizeCluster?: (nodes: MemoryNode[]) => Promise<string>;
}

export class GistExtractor {
  constructor(private readonly input: GistExtractorInput) {}

  async extractAbstractions(timeWindow: { start: number; end: number }): Promise<GistReport> {
    const config = this.input.getCognitionConfig();
    const eventNodes = this.input.graph
      .getNodesByTimeWindow(timeWindow.start, timeWindow.end)
      .filter((node) => node.type === "event");
    const clusters = this.agglomerativeClustering(eventNodes, config.consolidation.cluster_similarity_threshold);

    let abstractNodesCreated = 0;
    let skippedClusters = 0;
    let newRelatedEdges = 0;
    let clusterCount = 0;

    for (const cluster of clusters) {
      if (cluster.length < config.consolidation.min_cluster_size) {
        continue;
      }
      clusterCount += 1;
      const summary = await this.safeSummarizeCluster(cluster);
      if (!summary) {
        skippedClusters += 1;
        continue;
      }

      const createdAt = Date.now();
      const earliest = Math.min(...cluster.map((node) => node.created_at));
      const latest = Math.max(...cluster.map((node) => node.created_at));
      const abstractNode = this.input.graph.addNode({
        id: randomUUID(),
        content: summary,
        type: "abstract_summary",
        embedding: meanEmbedding(cluster),
        activation_level: 0,
        activation_history: [],
        base_level_activation: Math.max(...cluster.map((node) => node.base_level_activation)),
        emotional_valence: cluster.reduce((sum, node) => sum + node.emotional_valence, 0) / cluster.length,
        created_at: createdAt,
        last_activated_at: createdAt,
        source_time_range: {
          earliest: new Date(earliest).toISOString(),
          latest: new Date(latest).toISOString()
        },
        source_node_count: cluster.length,
        metadata: {
          consolidated_from: cluster.map((node) => node.id)
        }
      } satisfies MemoryNode);

      for (const member of cluster) {
        this.input.graph.addEdge({
          id: randomUUID(),
          source: abstractNode.id,
          target: member.id,
          relation_type: "abstracts",
          weight: 0.8,
          created_at: createdAt,
          last_activated_at: createdAt
        } satisfies MemoryEdge);
      }

      const relatedCandidates = new Map<string, number[]>();
      const memberIds = new Set(cluster.map((node) => node.id));
      for (const member of cluster) {
        for (const edge of this.input.graph.getOutgoingEdges(member.id)) {
          if (edge.weight <= 0.5 || memberIds.has(edge.target)) {
            continue;
          }
          const bucket = relatedCandidates.get(edge.target) ?? [];
          bucket.push(edge.weight);
          relatedCandidates.set(edge.target, bucket);
        }
      }

      for (const [targetId, weights] of relatedCandidates.entries()) {
        const weight = weights.reduce((sum, value) => sum + value, 0) / weights.length;
        this.input.graph.addEdge({
          id: randomUUID(),
          source: abstractNode.id,
          target: targetId,
          relation_type: "related_to",
          weight,
          created_at: createdAt,
          last_activated_at: createdAt
        } satisfies MemoryEdge);
        newRelatedEdges += 1;
      }

      abstractNodesCreated += 1;
    }

    return {
      clusterCount,
      abstractNodesCreated,
      skippedClusters,
      newRelatedEdges
    };
  }

  agglomerativeClustering(nodes: MemoryNode[], threshold: number): MemoryNode[][] {
    const visited = new Set<string>();
    const clusters: MemoryNode[][] = [];

    for (const node of nodes) {
      if (visited.has(node.id)) {
        continue;
      }
      const cluster: MemoryNode[] = [];
      const queue: MemoryNode[] = [node];
      visited.add(node.id);

      while (queue.length > 0) {
        const current = queue.shift()!;
        cluster.push(current);
        for (const candidate of nodes) {
          if (visited.has(candidate.id)) {
            continue;
          }
          if (cosineSimilarity(current.embedding, candidate.embedding) >= threshold) {
            visited.add(candidate.id);
            queue.push(candidate);
          }
        }
      }

      clusters.push(cluster);
    }

    return clusters;
  }

  private async safeSummarizeCluster(nodes: MemoryNode[]): Promise<string | null> {
    if (!this.input.summarizeCluster) {
      return nodes
        .map((node) => node.content)
        .slice(0, 3)
        .join("；");
    }
    try {
      const summary = (await this.input.summarizeCluster(nodes)).trim();
      return summary || null;
    } catch {
      return null;
    }
  }
}
