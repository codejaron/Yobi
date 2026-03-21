import { z } from "zod";

export type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends Array<infer U>
    ? Array<DeepPartial<U>>
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

export const memoryNodeTypeSchema = z.enum([
  "fact",
  "event",
  "concept",
  "emotion_anchor",
  "external_entity",
  "time_marker",
  "intent",
  "pattern"
]);

export const memoryEdgeRelationSchema = z.enum([
  "semantic",
  "temporal",
  "causal",
  "emotional",
  "contrast",
  "conversation",
  "sequential"
]);

export const thoughtBubbleStatusSchema = z.enum([
  "nascent",
  "mature",
  "expressed",
  "decayed"
]);

export const cognitionConfigSchema = z.object({
  spreading: z.object({
    spreading_factor: z.number(),
    retention_delta: z.number(),
    temporal_decay_rho: z.number(),
    diffusion_max_depth: z.number().int(),
    spreading_size_limit: z.number().int()
  }).strict(),
  inhibition: z.object({
    lateral_inhibition_top_M: z.number().int(),
    lateral_inhibition_beta: z.number()
  }).strict(),
  sigmoid: z.object({
    gamma: z.number(),
    theta: z.number()
  }).strict(),
  actr: z.object({
    decay_d: z.number()
  }).strict(),
  hebbian: z.object({
    learning_rate: z.number(),
    normalization_cap: z.number()
  }).strict(),
  retrieval_weights: z.object({
    lambda_semantic: z.number(),
    lambda_activation: z.number(),
    lambda_structural: z.number()
  }).strict(),
  metacognition: z.object({
    fok_gate_threshold: z.number()
  }).strict(),
  graph_maintenance: z.object({
    node_dormancy_threshold: z.number(),
    dormancy_window: z.number().int(),
    hot_zone_max_nodes: z.number().int(),
    duplicate_detection_threshold: z.number(),
    max_edges_per_node: z.number().int()
  }).strict(),
  loop: z.object({
    heartbeat_lambda_minutes: z.number()
  }).strict(),
  expression: z.object({
    activation_threshold: z.number(),
    cooldown_minutes: z.number()
  }).strict()
}).strict();

export type CognitionConfig = z.infer<typeof cognitionConfigSchema>;
export type SpreadingConfig = CognitionConfig["spreading"];
export type ActrConfig = CognitionConfig["actr"];
export type GraphMaintenanceConfig = CognitionConfig["graph_maintenance"];
export type ExpressionConfig = CognitionConfig["expression"];
export type CognitionConfigPatch = DeepPartial<CognitionConfig>;

export const DEFAULT_COGNITION_CONFIG: CognitionConfig = {
  spreading: {
    spreading_factor: 0.8,
    retention_delta: 0.5,
    temporal_decay_rho: 0.01,
    diffusion_max_depth: 3,
    spreading_size_limit: 300
  },
  inhibition: {
    lateral_inhibition_top_M: 7,
    lateral_inhibition_beta: 0.1
  },
  sigmoid: {
    gamma: 10,
    theta: 0.3
  },
  actr: {
    decay_d: 0.5
  },
  hebbian: {
    learning_rate: 0.05,
    normalization_cap: 5
  },
  retrieval_weights: {
    lambda_semantic: 0.5,
    lambda_activation: 0.3,
    lambda_structural: 0.2
  },
  metacognition: {
    fok_gate_threshold: 0.12
  },
  graph_maintenance: {
    node_dormancy_threshold: 0.01,
    dormancy_window: 10,
    hot_zone_max_nodes: 10_000,
    duplicate_detection_threshold: 0.92,
    max_edges_per_node: 15
  },
  loop: {
    heartbeat_lambda_minutes: 15
  },
  expression: {
    activation_threshold: 0.4,
    cooldown_minutes: 30
  }
};

export interface MemoryNode {
  id: string;
  content: string;
  type: z.infer<typeof memoryNodeTypeSchema>;
  embedding: number[];
  activation_level: number;
  activation_history: number[];
  base_level_activation: number;
  emotional_valence: number;
  created_at: number;
  last_activated_at: number;
  metadata: Record<string, unknown>;
}

export interface MemoryEdge {
  id: string;
  source: string;
  target: string;
  relation_type: z.infer<typeof memoryEdgeRelationSchema>;
  weight: number;
  created_at: number;
  last_activated_at: number;
}

export interface ActivatedNodeRef {
  node_id: string;
  activation: number;
}

export interface ThoughtBubble {
  id: string;
  summary: string;
  source_seeds: string[];
  activated_nodes: ActivatedNodeRef[];
  activation_peak: number;
  emotional_tone: number;
  novelty_score: number;
  created_at: number;
  last_reinforced_at: number;
  status: z.infer<typeof thoughtBubbleStatusSchema>;
}

export interface ActivationSeedLabel {
  node_id: string;
  label: string;
}

export interface ActivationTopNode {
  node_id: string;
  label: string;
  activation: number;
}

export interface ActivationHopSummary {
  depth: number;
  nodes: ActivationTopNode[];
}

export interface CognitionConfigSnapshot {
  spreading_factor: number;
  retention_delta: number;
  temporal_decay_rho: number;
  diffusion_max_depth: number;
  spreading_size_limit: number;
  expression_activation_threshold: number;
  expression_cooldown_minutes: number;
  heartbeat_lambda_minutes: number;
  duplicate_detection_threshold: number;
  max_edges_per_node: number;
}

export interface BubbleEvaluationDimensions {
  relevance: number;
  information_gap: number;
  timing: number;
  novelty: number;
  expected_impact: number;
  relationship_fit: number;
}

export interface ActivationLogEntry {
  timestamp: number;
  trigger_type: string;
  seeds: ActivationSeedLabel[];
  top_activated: ActivationTopNode[];
  path_log?: ActivationPathLogRound[] | null;
  hop_summaries?: ActivationHopSummary[] | null;
  config_snapshot?: CognitionConfigSnapshot | null;
  activated_count?: number | null;
  activation_peak?: number | null;
  bubbles_generated: number;
  bubble_passed_filter: boolean;
  expression_produced: boolean;
  expression_text: string | null;
  bubble_id?: string | null;
  bubble_summary?: string | null;
  evaluation_score?: number | null;
  evaluation_dimensions?: BubbleEvaluationDimensions | null;
  manual_text?: string | null;
  expression_reason?: string | null;
}

export interface MemoryGraphSnapshot {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  stats: {
    node_count: number;
    edge_count: number;
    avg_activation: number;
  };
}

export interface ThoughtPoolSnapshot {
  bubbles: ThoughtBubble[];
  history_count: number;
}

export interface ActivationPathLogRound {
  depth: number;
  frontier: Array<{ node_id: string; activation: number }>;
  retained: Array<{ node_id: string; activation: number }>;
  propagated: Array<{ from: string; to: string; activation: number; relation_type: MemoryEdge["relation_type"] }>;
}

export interface ActivationResult {
  activated: Map<string, number>;
  path_log: ActivationPathLogRound[];
}

export interface CognitionDebugSnapshot {
  graph: MemoryGraphSnapshot;
  thoughts: ThoughtPoolSnapshot;
  config: CognitionConfig;
  lastLogs: ActivationLogEntry[];
}

export interface DialogueExtractionDraft {
  nodes: Array<{
    content: string;
    type: MemoryNode["type"];
    emotional_valence?: number;
  }>;
  edges: Array<{
    source_content: string;
    target_content: string;
    relation_type: MemoryEdge["relation_type"];
    weight?: number;
  }>;
}
