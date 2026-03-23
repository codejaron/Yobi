import fs from "node:fs";
import { encode, decode } from "@msgpack/msgpack";
import type { CompanionPaths } from "@main/storage/paths";
import type { DebugMemoryNode, GraphMaintenanceConfig, MemoryEdge, MemoryGraphSnapshot, MemoryNode } from "@shared/cognition";
import type { MemoryGraph } from "./types";

interface SerializedMemoryGraph {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
}

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

function sortScoredNodes(
  values: Array<{ node: MemoryNode; score: number }>
): Array<{ node: MemoryNode; score: number }> {
  return values.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.node.id.localeCompare(right.node.id);
  });
}

function normalizeNode(raw: MemoryNode): MemoryNode {
  return {
    ...raw,
    activation_history: [...raw.activation_history].sort((left, right) => left - right),
    metadata: raw.metadata ?? {}
  };
}

function normalizeEdge(raw: MemoryEdge): MemoryEdge {
  return {
    ...raw,
    weight: Math.max(0, Math.min(1, raw.weight))
  };
}

export class MemoryGraphStore {
  private readonly graph: MemoryGraph = {
    nodes: new Map(),
    edges: [],
    adjacency: new Map()
  };

  constructor(
    private readonly paths: CompanionPaths,
    private config: GraphMaintenanceConfig
  ) {
    this.loadHotGraph();
  }

  addNode(node: MemoryNode, options?: { skipDuplicateDetection?: boolean }): MemoryNode {
    const normalized = normalizeNode(node);
    const duplicate = options?.skipDuplicateDetection ? null : this.findDuplicate(normalized);
    if (duplicate) {
      const duplicateLastConsolidatedAt = duplicate.last_consolidated_at
        ? Date.parse(duplicate.last_consolidated_at)
        : Number.NEGATIVE_INFINITY;
      const normalizedLastConsolidatedAt = normalized.last_consolidated_at
        ? Date.parse(normalized.last_consolidated_at)
        : Number.NEGATIVE_INFINITY;
      const merged: MemoryNode = {
        ...duplicate,
        content: normalized.created_at >= duplicate.created_at ? normalized.content : duplicate.content,
        type: normalized.created_at >= duplicate.created_at ? normalized.type : duplicate.type,
        embedding: normalized.embedding.length > 0 ? normalized.embedding : duplicate.embedding,
        activation_level: Math.max(duplicate.activation_level, normalized.activation_level),
        activation_history: [...new Set([...duplicate.activation_history, ...normalized.activation_history])].sort(
          (left, right) => left - right
        ),
        base_level_activation: Math.max(duplicate.base_level_activation, normalized.base_level_activation),
        emotional_valence: normalized.created_at >= duplicate.created_at
          ? normalized.emotional_valence
          : duplicate.emotional_valence,
        created_at: Math.min(duplicate.created_at, normalized.created_at),
        last_activated_at: Math.max(duplicate.last_activated_at, normalized.last_activated_at),
        source_time_range: normalized.source_time_range ?? duplicate.source_time_range,
        source_node_count: normalized.source_node_count ?? duplicate.source_node_count,
        consolidation_count: Math.max(
          duplicate.consolidation_count ?? 0,
          normalized.consolidation_count ?? 0
        ) || undefined,
        last_consolidated_at: normalizedLastConsolidatedAt >= duplicateLastConsolidatedAt
          ? (normalized.last_consolidated_at ?? duplicate.last_consolidated_at)
          : duplicate.last_consolidated_at,
        metadata: {
          ...duplicate.metadata,
          ...normalized.metadata
        }
      };
      this.graph.nodes.set(duplicate.id, merged);
      this.ensureAdjacencyEntry(duplicate.id);
      return merged;
    }

    this.graph.nodes.set(normalized.id, normalized);
    this.ensureAdjacencyEntry(normalized.id);
    return normalized;
  }

  addEdge(edge: MemoryEdge): MemoryEdge {
    const normalized = normalizeEdge(edge);
    if (normalized.source === normalized.target) {
      return normalized;
    }
    const existingIndex = this.graph.edges.findIndex((candidate) =>
      candidate.id === normalized.id ||
      (
        candidate.source === normalized.source &&
        candidate.target === normalized.target &&
        candidate.relation_type === normalized.relation_type
      )
    );

    if (existingIndex >= 0) {
      this.graph.edges[existingIndex] = normalized;
      this.rebuildAdjacency();
      return normalized;
    }

    const outgoing = this.graph.edges.filter((candidate) => candidate.source === normalized.source);
    if (outgoing.length >= this.config.max_edges_per_node) {
      const weakest = [...outgoing].sort((left, right) => left.weight - right.weight)[0];
      if (weakest) {
        this.graph.edges = this.graph.edges.filter((candidate) => candidate.id !== weakest.id);
      }
    }

    this.graph.edges.push(normalized);
    this.rebuildAdjacency();
    return normalized;
  }

  getNeighbors(nodeId: string): Array<{ target: string; edge: MemoryEdge; node: MemoryNode | undefined }> {
    const entries = this.graph.adjacency.get(nodeId) ?? [];
    return entries
      .map((entry) => {
        const edge = this.graph.edges.find((candidate) => candidate.id === entry.edge_id);
        if (!edge) {
          return null;
        }
        return {
          target: entry.target,
          edge,
          node: this.graph.nodes.get(entry.target)
        };
      })
      .filter((value): value is { target: string; edge: MemoryEdge; node: MemoryNode | undefined } => value !== null);
  }

  getNode(id: string): MemoryNode | undefined {
    return this.graph.nodes.get(id);
  }

  replaceNode(node: MemoryNode): MemoryNode | null {
    if (!this.graph.nodes.has(node.id)) {
      return null;
    }

    const normalized = normalizeNode(node);
    this.graph.nodes.set(normalized.id, normalized);
    this.ensureAdjacencyEntry(normalized.id);
    return normalized;
  }

  getAllNodes(): MemoryNode[] {
    return [...this.graph.nodes.values()];
  }

  getAllEdges(): MemoryEdge[] {
    return [...this.graph.edges];
  }

  getEdgeById(id: string): MemoryEdge | null {
    return this.graph.edges.find((edge) => edge.id === id) ?? null;
  }

  getEdgesBetween(source: string, target: string): MemoryEdge[] {
    return this.graph.edges.filter((edge) => edge.source === source && edge.target === target);
  }

  getOutgoingEdges(nodeId: string): MemoryEdge[] {
    const adjacency = this.graph.adjacency.get(nodeId) ?? [];
    return adjacency
      .map((entry) => this.getEdgeById(entry.edge_id))
      .filter((edge): edge is MemoryEdge => edge !== null);
  }

  getIncomingEdges(nodeId: string): MemoryEdge[] {
    return this.graph.edges.filter((edge) => edge.target === nodeId);
  }

  getRandomNode(): MemoryNode | null {
    const nodes = this.getAllNodes();
    if (nodes.length === 0) {
      return null;
    }
    return nodes[Math.floor(Math.random() * nodes.length)] ?? null;
  }

  getMaxActivation(): number {
    let max = 0;
    for (const node of this.graph.nodes.values()) {
      if (node.activation_level > max) {
        max = node.activation_level;
      }
    }
    return max;
  }

  findByEmbeddingSimilarity(embedding: number[], topK: number): MemoryNode[] {
    return sortScoredNodes(
      this.getAllNodes().map((node) => ({
        node,
        score: cosineSimilarity(node.embedding, embedding)
      }))
    )
      .slice(0, topK)
      .map((item) => item.node);
  }

  getNodesByTimeWindow(start: number, end: number): MemoryNode[] {
    return this.getAllNodes().filter((node) => node.created_at >= start && node.created_at <= end);
  }

  removeNodes(nodeIds: string[]): void {
    if (nodeIds.length === 0) {
      return;
    }

    const idSet = new Set(nodeIds);
    for (const nodeId of idSet) {
      this.graph.nodes.delete(nodeId);
      this.graph.adjacency.delete(nodeId);
    }

    this.graph.edges = this.graph.edges.filter((edge) => !idSet.has(edge.source) && !idSet.has(edge.target));
    this.rebuildAdjacency();
  }

  getOrphanNodes(): MemoryNode[] {
    return this.getAllNodes().filter((node) => this.getDegreeCentrality(node.id) === 0);
  }

  getDegreeCentrality(nodeId: string): number {
    return this.getOutgoingEdges(nodeId).length + this.getIncomingEdges(nodeId).length;
  }

  getStatistics(): {
    nodeCount: number;
    edgeCount: number;
    meanWeight: number;
    maxWeight: number;
  } {
    const edges = this.getAllEdges();
    const totalWeight = edges.reduce((sum, edge) => sum + edge.weight, 0);
    return {
      nodeCount: this.graph.nodes.size,
      edgeCount: edges.length,
      meanWeight: edges.length > 0 ? totalWeight / edges.length : 0,
      maxWeight: edges.length > 0 ? Math.max(...edges.map((edge) => edge.weight)) : 0
    };
  }

  reset(): void {
    this.graph.nodes.clear();
    this.graph.edges = [];
    this.graph.adjacency.clear();
  }

  updateActivation(nodeId: string, newLevel: number): void {
    const node = this.graph.nodes.get(nodeId);
    if (!node) {
      return;
    }

    const now = Date.now();
    const next: MemoryNode = {
      ...node,
      activation_level: newLevel,
      activation_history: [...node.activation_history, now],
      last_activated_at: now
    };
    this.graph.nodes.set(nodeId, next);
  }

  setActivationLevel(nodeId: string, newLevel: number): void {
    const node = this.graph.nodes.get(nodeId);
    if (!node) {
      return;
    }

    this.graph.nodes.set(nodeId, {
      ...node,
      activation_level: newLevel
    });
  }

  computeBaseLevelActivation(nodeId: string, now: number, decayD = 0.5): number {
    const node = this.graph.nodes.get(nodeId);
    if (!node) {
      return Number.NEGATIVE_INFINITY;
    }

    if (node.activation_history.length === 0) {
      const next = {
        ...node,
        base_level_activation: Number.NEGATIVE_INFINITY
      };
      this.graph.nodes.set(nodeId, next);
      return next.base_level_activation;
    }

    const total = node.activation_history.reduce((sum, timestamp) => {
      const deltaSeconds = Math.max(1, (now - timestamp) / 1000);
      return sum + Math.pow(deltaSeconds, -decayD);
    }, 0);
    const next = {
      ...node,
      base_level_activation: Math.log(total)
    };
    this.graph.nodes.set(nodeId, next);
    return next.base_level_activation;
  }

  getTopByBaseLevel(input: {
    limit: number;
    nowMs: number;
    decayD: number;
    candidateIds?: string[];
    minHistoryLength?: number;
  }): MemoryNode[] {
    const candidateSet = input.candidateIds ? new Set(input.candidateIds) : null;
    const minHistoryLength = input.minHistoryLength ?? 0;
    const scored: Array<{ node: MemoryNode; score: number }> = [];

    for (const node of this.graph.nodes.values()) {
      if (candidateSet && !candidateSet.has(node.id)) {
        continue;
      }
      if (node.activation_history.length < minHistoryLength) {
        continue;
      }
      const score = this.computeBaseLevelActivation(node.id, input.nowMs, input.decayD);
      if (!Number.isFinite(score)) {
        continue;
      }
      const refreshed = this.graph.nodes.get(node.id);
      if (!refreshed) {
        continue;
      }
      scored.push({
        node: refreshed,
        score
      });
    }

    return sortScoredNodes(scored)
      .slice(0, input.limit)
      .map((item) => item.node);
  }

  serialize(): Uint8Array {
    const payload = encode({
      nodes: this.getAllNodes(),
      edges: this.graph.edges
    } satisfies SerializedMemoryGraph);
    fs.mkdirSync(this.paths.cognitionDir, { recursive: true });
    fs.writeFileSync(this.paths.cognitionGraphHotPath, payload);
    return payload;
  }

  setGraphMaintenanceConfig(config: GraphMaintenanceConfig): void {
    this.config = config;
  }

  deserialize(buffer: Uint8Array): void {
    const parsed = decode(buffer) as SerializedMemoryGraph;
    this.graph.nodes.clear();
    this.graph.edges = [];
    this.graph.adjacency.clear();

    for (const node of parsed.nodes ?? []) {
      this.graph.nodes.set(node.id, normalizeNode(node));
      this.ensureAdjacencyEntry(node.id);
    }
    this.graph.edges = (parsed.edges ?? []).map((edge) => normalizeEdge(edge));
    this.rebuildAdjacency();
  }

  toJSON(): MemoryGraphSnapshot {
    const rawNodes = this.getAllNodes();
    const totalActivation = rawNodes.reduce((sum, node) => sum + node.activation_level, 0);
    const nodes: DebugMemoryNode[] = rawNodes.map((node) => {
      const { embedding: _embedding, activation_history, ...rest } = node;
      return {
        ...rest,
        activation_history_count: activation_history.length
      };
    });
    return {
      nodes,
      edges: [...this.graph.edges],
      stats: {
        node_count: nodes.length,
        edge_count: this.graph.edges.length,
        avg_activation: nodes.length > 0 ? totalActivation / nodes.length : 0
      }
    };
  }

  private ensureAdjacencyEntry(nodeId: string): void {
    if (!this.graph.adjacency.has(nodeId)) {
      this.graph.adjacency.set(nodeId, []);
    }
  }

  private rebuildAdjacency(): void {
    const next = new Map<string, Array<{ edge_id: string; target: string }>>();
    for (const nodeId of this.graph.nodes.keys()) {
      next.set(nodeId, []);
    }
    for (const edge of this.graph.edges) {
      const row = next.get(edge.source) ?? [];
      row.push({
        edge_id: edge.id,
        target: edge.target
      });
      next.set(edge.source, row);
      if (!next.has(edge.target)) {
        next.set(edge.target, []);
      }
    }
    this.graph.adjacency.clear();
    for (const [nodeId, row] of next.entries()) {
      this.graph.adjacency.set(nodeId, row);
    }
  }

  private findDuplicate(node: MemoryNode): MemoryNode | null {
    if (node.embedding.length === 0) {
      return null;
    }

    let best: { node: MemoryNode; score: number } | null = null;
    for (const candidate of this.graph.nodes.values()) {
      // Abstract summaries must remain distinct nodes even when their mean embeddings
      // are close to the events they summarize.
      if (node.type === "abstract_summary" || candidate.type === "abstract_summary") {
        continue;
      }
      if (node.type === "person" || candidate.type === "person") {
        continue;
      }
      if (candidate.type !== node.type) {
        continue;
      }
      if (candidate.embedding.length === 0) {
        continue;
      }
      const score = cosineSimilarity(node.embedding, candidate.embedding);
      if (score < this.config.duplicate_detection_threshold) {
        continue;
      }
      if (!best || score > best.score) {
        best = {
          node: candidate,
          score
        };
      }
    }

    return best?.node ?? null;
  }

  private loadHotGraph(): void {
    try {
      if (!fs.existsSync(this.paths.cognitionGraphHotPath)) {
        return;
      }
      const buffer = fs.readFileSync(this.paths.cognitionGraphHotPath);
      if (buffer.length === 0) {
        return;
      }
      this.deserialize(buffer);
    } catch {
      this.graph.nodes.clear();
      this.graph.edges = [];
      this.graph.adjacency.clear();
    }
  }
}
