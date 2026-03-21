import type { MemoryEdge, MemoryNode } from "@shared/cognition";

export type {
  ActivationLogEntry,
  ActivatedNodeRef,
  BubbleEvaluationDimensions,
  CognitionConfig,
  CognitionDebugSnapshot,
  MemoryEdge,
  MemoryNode,
  ThoughtBubble
} from "@shared/cognition";

export interface MemoryGraph {
  nodes: Map<string, MemoryNode>;
  edges: MemoryEdge[];
  adjacency: Map<string, Array<{ edge_id: string; target: string }>>;
}
