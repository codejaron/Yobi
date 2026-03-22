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
    decay_d: z.number(),
    base_level_scale: z.number()
  }).strict(),
  hebbian: z.object({
    learning_rate: z.number(),
    normalization_cap: z.number(),
    decay_lambda: z.number(),
    passive_decay_rate: z.number(),
    weight_min: z.number(),
    weight_max: z.number()
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
    heartbeat_lambda_minutes: z.number(),
    min_interval_minutes: z.number(),
    max_interval_minutes: z.number(),
    active_hours: z.object({
      start: z.number().int(),
      end: z.number().int()
    }).strict(),
    enabled: z.boolean()
  }).strict(),
  triggers: z.object({
    dialogue_residue_window_minutes: z.number(),
    silence_threshold_minutes: z.number(),
    random_walk_probability: z.number(),
    rescue_activation_floor: z.number()
  }).strict(),
  emotion: z.object({
    modulation_strength: z.number(),
    valence_weight: z.number(),
    arousal_weight: z.number(),
    decay_rate: z.number(),
    analysis_model: z.string(),
    neutral_state: z.object({
      valence: z.number(),
      arousal: z.number()
    }).strict()
  }).strict(),
  prediction: z.object({
    history_window: z.number().int(),
    surprise_bonus: z.number(),
    familiarity_penalty: z.number(),
    similarity_threshold: z.number()
  }).strict(),
  attention: z.object({
    max_focus_nodes: z.number().int(),
    focus_seed_energy: z.number(),
    update_on: z.enum(["every_diffusion"])
  }).strict(),
  expression: z.object({
    activation_threshold: z.number(),
    cooldown_minutes: z.number()
  }).strict()
}).strict();

export type CognitionConfig = z.infer<typeof cognitionConfigSchema>;
export type SpreadingConfig = CognitionConfig["spreading"];
export type ActrConfig = CognitionConfig["actr"];
export type HebbianConfig = CognitionConfig["hebbian"];
export type GraphMaintenanceConfig = CognitionConfig["graph_maintenance"];
export type LoopConfig = CognitionConfig["loop"];
export type TriggerConfig = CognitionConfig["triggers"];
export type EmotionConfig = CognitionConfig["emotion"];
export type PredictionConfig = CognitionConfig["prediction"];
export type AttentionConfig = CognitionConfig["attention"];
export type ExpressionConfig = CognitionConfig["expression"];
export type CognitionConfigPatch = DeepPartial<CognitionConfig>;

export const DEFAULT_COGNITION_CONFIG: CognitionConfig = {
  spreading: {
    spreading_factor: 0.8,
    retention_delta: 0.5,
    temporal_decay_rho: 0.01,
    diffusion_max_depth: 3,
    spreading_size_limit: 50
  },
  inhibition: {
    lateral_inhibition_top_M: 3,
    lateral_inhibition_beta: 0.1
  },
  sigmoid: {
    gamma: 10,
    theta: 0.3
  },
  actr: {
    decay_d: 0.5,
    base_level_scale: 0.1
  },
  hebbian: {
    learning_rate: 0.05,
    normalization_cap: 5,
    decay_lambda: 0.01,
    passive_decay_rate: 0.001,
    weight_min: 0.01,
    weight_max: 1
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
    heartbeat_lambda_minutes: 15,
    min_interval_minutes: 3,
    max_interval_minutes: 60,
    active_hours: {
      start: 7,
      end: 23
    },
    enabled: true
  },
  triggers: {
    dialogue_residue_window_minutes: 30,
    silence_threshold_minutes: 45,
    random_walk_probability: 0.2,
    rescue_activation_floor: 0.05
  },
  emotion: {
    modulation_strength: 0.25,
    valence_weight: 0.7,
    arousal_weight: 0.3,
    decay_rate: 0.05,
    analysis_model: "cheap",
    neutral_state: {
      valence: 0.1,
      arousal: 0.3
    }
  },
  prediction: {
    history_window: 5,
    surprise_bonus: 0.15,
    familiarity_penalty: 0.1,
    similarity_threshold: 0.85
  },
  attention: {
    max_focus_nodes: 5,
    focus_seed_energy: 0.3,
    update_on: "every_diffusion"
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
  hebbian_learning_rate: number;
  passive_decay_rate: number;
  random_walk_probability: number;
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

export interface TriggerSourceSummary {
  type: string;
  source_description: string;
}

export interface EdgeChange {
  edge_id?: string | null;
  source_id?: string | null;
  target_id?: string | null;
  source_content: string;
  target_content: string;
  weight_before: number;
  weight_after: number;
  delta: number;
}

export interface HebbianUpdateLog {
  edges_updated: number;
  edges_strengthened: number;
  edges_weakened: number;
  normalization_triggered_nodes: number;
  max_weight_after: number;
  min_weight_after: number;
  avg_weight_after: number;
  top_strengthened: EdgeChange[];
  top_weakened: EdgeChange[];
}

export interface EdgeDecayLog {
  edges_decayed: number;
  edges_at_minimum: number;
}

export interface GraphStatsSnapshot {
  avg_weight: number;
  median_weight: number;
  std_weight: number;
  min_weight: number;
  max_weight: number;
  node_count: number;
  edge_count: number;
  avg_activation: number;
}

export interface HeartbeatStats {
  ticks_total: number;
  avg_interval_actual_ms: number;
  last_tick_time: number;
  next_scheduled_time: number | null;
}

export interface HealthAlert {
  level: "info" | "warning" | "error";
  msg: string;
}

export interface HealthMetrics {
  total_ticks: number;
  uptime_hours: number;
  empty_tick_ratio: number;
  expression_ratio: number;
  avg_top1_activation: number;
  weight_mean_current: number;
  weight_mean_trend: number;
  path_diversity: number;
  alerts: HealthAlert[];
  heartbeat_stats: HeartbeatStats;
}

export interface EmotionWorkspaceState {
  valence: number;
  arousal: number;
  last_updated: string;
  source: string;
}

export interface PredictionWorkspaceState {
  warming_up: boolean;
  progress: string;
  history_window: number;
  last_similarity?: number | null;
  surprising_node_ids?: string[] | null;
  familiar_node_ids?: string[] | null;
}

export interface AttentionWorkspaceState {
  focus_node_ids: string[];
  max_focus_nodes: number;
  focus_seed_energy: number;
}

export interface CognitionWorkspaceSnapshot {
  emotion: EmotionWorkspaceState;
  prediction: PredictionWorkspaceState;
  attention: AttentionWorkspaceState;
}

export interface ActivationLogEntry {
  timestamp: number;
  trigger_type: string;
  trigger_sources?: TriggerSourceSummary[] | null;
  duration_ms?: number | null;
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
  hebbian_log?: HebbianUpdateLog | null;
  edge_decay_log?: EdgeDecayLog | null;
  graph_stats?: GraphStatsSnapshot | null;
  prediction_status?: "warming_up" | "active" | null;
  prediction_progress?: string | null;
  prediction_similarity?: number | null;
  surprising_nodes?: Array<{ node_id: string; activation: number }> | null;
  familiar_nodes?: Array<{ node_id: string; activation: number }> | null;
  emotion_snapshot?: {
    valence: number;
    arousal: number;
    source: string;
  } | null;
  attention_focus?: string[] | null;
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
  propagation_totals?: Array<{ node_id: string; activation: number }>;
  inhibition_winners?: Array<{ node_id: string; activation: number }>;
  inhibited_totals?: Array<{ node_id: string; activation: number }>;
  gated_totals?: Array<{ node_id: string; activation: number }>;
  trimmed_totals?: Array<{ node_id: string; activation: number }>;
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
  workspace: CognitionWorkspaceSnapshot;
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
