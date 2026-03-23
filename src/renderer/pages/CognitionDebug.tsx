import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import {
  DEFAULT_COGNITION_CONFIG,
  type ActivationLogEntry,
  type ActivationPathLogRound,
  type BroadcastSummary,
  type CognitionConfig,
  type CognitionConfigPatch,
  type CognitionDebugSnapshot,
  type ColdArchiveStats,
  type ConsolidationReport,
  type HealthMetrics,
  type MemoryEdge,
  type MemoryNode
} from "@shared/cognition";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@renderer/components/ui/card";
import { cn } from "@renderer/lib/utils";

const NODE_COLORS: Record<MemoryNode["type"], string> = {
  fact: "#4A90D9",
  event: "#7EC680",
  concept: "#F5A623",
  person: "#4B5BDE",
  emotion_anchor: "#D0021B",
  external_entity: "#9013FE",
  time_marker: "#9B9B9B",
  intent: "#50E3C2",
  pattern: "#8B572A",
  abstract_summary: "#C17C2F"
};

type GraphNode = MemoryNode & {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  index?: number;
};

type GraphLink = MemoryEdge & {
  source: string | GraphNode;
  target: string | GraphNode;
};

interface PlaybackSession {
  timestamp: number;
  pathLog: ActivationPathLogRound[];
}

interface PlaybackFrame {
  roundIndex: number;
  progress: number;
}

type StageNodeActivation = {
  node_id: string;
  activation: number;
};

type ExtendedPathRound = ActivationPathLogRound & {
  propagation_totals?: StageNodeActivation[];
  inhibition_winners?: StageNodeActivation[] | string[];
  inhibited_totals?: StageNodeActivation[];
  gated_totals?: StageNodeActivation[];
  trimmed_totals?: StageNodeActivation[];
};

type WorkspaceEmotionSnapshot = {
  valence: number;
  arousal: number;
  last_updated?: string | number | null;
  source?: string | null;
};

type WorkspacePredictionSnapshot = {
  warming_up?: boolean;
  progress?: string | null;
  history_window?: number;
  last_similarity?: number | null;
  surprising_node_ids?: string[] | null;
  familiar_node_ids?: string[] | null;
};

type WorkspaceAttentionSnapshot = {
  focus_node_ids?: string[] | null;
  max_focus_nodes?: number;
  focus_seed_energy?: number;
};

type CognitionWorkspaceSnapshot = {
  emotion?: WorkspaceEmotionSnapshot | null;
  prediction?: WorkspacePredictionSnapshot | null;
  attention?: WorkspaceAttentionSnapshot | null;
};

type ParameterGroupId =
  | "quick_toggles"
  | "spreading_core"
  | "expression_loop"
  | "learning_broadcast"
  | "consolidation_archive"
  | "advanced_experiments";

type ToggleDefinition = {
  id: "broadcast_enabled" | "consolidation_enabled";
  group: ParameterGroupId;
  label: string;
  compactLabel: string;
  description: string;
  referenceText: string;
  state: (cfg: CognitionConfig) => boolean;
  update: (value: boolean) => CognitionConfigPatch;
  summaryFormatter: (value: boolean) => string;
};

type SliderDefinition = {
  id: string;
  group: ParameterGroupId;
  label: string;
  compactLabel: string;
  description: string;
  referenceText: string;
  min: number;
  max: number;
  step: number;
  state: (cfg: CognitionConfig) => number;
  update: (value: number) => CognitionConfigPatch;
  summaryFormatter: (value: number) => string;
};

type ParameterGroupDefinition = {
  id: ParameterGroupId;
  title: string;
  description: string;
  summaryIds: string[];
};

type BottomTabId = "timeline" | "experiments";

type DrawerSectionId = "graph_diagnostics" | "cognition_state" | "system_events";

type GraphViewport = {
  scale: number;
  offsetX: number;
  offsetY: number;
};

function broadcastHistoryOf(snapshot: CognitionDebugSnapshot | null): BroadcastSummary[] {
  return ((snapshot as unknown as { broadcastHistory?: BroadcastSummary[] })?.broadcastHistory ?? []) as BroadcastSummary[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function nodeRenderRadius(node: MemoryNode): number {
  return 8 + Math.min(32, node.activation_level * 32);
}

function normalizeStageEntries(value: unknown): StageNodeActivation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: StageNodeActivation[] = [];
  for (const item of value) {
    if (!item) {
      continue;
    }

    if (typeof item === "string") {
      normalized.push({ node_id: item, activation: 0 });
      continue;
    }

    if (typeof item !== "object") {
      continue;
    }

    const maybeNodeId =
      "node_id" in item && typeof item.node_id === "string"
        ? item.node_id
        : "nodeId" in item && typeof item.nodeId === "string"
          ? item.nodeId
          : null;
    if (!maybeNodeId) {
      continue;
    }

    const maybeActivation =
      "activation" in item && typeof item.activation === "number"
        ? item.activation
        : "value" in item && typeof item.value === "number"
          ? item.value
          : 0;
    normalized.push({ node_id: maybeNodeId, activation: maybeActivation });
  }

  return normalized;
}

function aggregatePropagation(round: ActivationPathLogRound): StageNodeActivation[] {
  const totals = new Map<string, number>();
  for (const edge of round.propagated) {
    totals.set(edge.to, (totals.get(edge.to) ?? 0) + edge.activation);
  }
  return [...totals.entries()].map(([node_id, activation]) => ({ node_id, activation }));
}

function rankStageEntries(entries: StageNodeActivation[]): StageNodeActivation[] {
  return [...entries]
    .sort((left, right) =>
      right.activation === left.activation
        ? left.node_id.localeCompare(right.node_id)
        : right.activation - left.activation
    )
    .slice(0, 5);
}

function formatStageEntries(input: {
  entries: StageNodeActivation[];
  labelById: Map<string, string>;
}): string {
  const ranked = rankStageEntries(input.entries);
  if (ranked.length === 0) {
    return "无";
  }
  return ranked
    .map((entry) => `${input.labelById.get(entry.node_id) ?? entry.node_id} (${entry.activation.toFixed(2)})`)
    .join(" · ");
}

function buildRoundStageRows(input: {
  pathLog: ActivationPathLogRound[] | null | undefined;
  labelById: Map<string, string>;
}): Array<{
  depth: number;
  propagation: string;
  inhibition: string;
  sigmoid: string;
  trimmed?: string;
}> {
  const rows: Array<{
    depth: number;
    propagation: string;
    inhibition: string;
    sigmoid: string;
    trimmed?: string;
  }> = [];

  for (const rawRound of input.pathLog ?? []) {
    const round = rawRound as ExtendedPathRound;
    const propagationTotals =
      normalizeStageEntries(round.propagation_totals).length > 0
        ? normalizeStageEntries(round.propagation_totals)
        : aggregatePropagation(rawRound);
    const inhibitionTotals =
      normalizeStageEntries(round.inhibited_totals).length > 0
        ? normalizeStageEntries(round.inhibited_totals)
        : normalizeStageEntries(round.inhibition_winners);
    const sigmoidTotals = normalizeStageEntries(round.gated_totals);
    const trimmedTotals = normalizeStageEntries(round.trimmed_totals);

    rows.push({
      depth: rawRound.depth,
      propagation: formatStageEntries({ entries: propagationTotals, labelById: input.labelById }),
      inhibition: formatStageEntries({ entries: inhibitionTotals, labelById: input.labelById }),
      sigmoid: formatStageEntries({ entries: sigmoidTotals, labelById: input.labelById }),
      trimmed: trimmedTotals.length > 0 ? formatStageEntries({ entries: trimmedTotals, labelById: input.labelById }) : undefined
    });
  }

  return rows;
}

function drawGraphCanvas(input: {
  context: CanvasRenderingContext2D;
  snapshot: CognitionDebugSnapshot | null;
  positions: Record<string, { x: number; y: number }>;
  width: number;
  height: number;
  viewport: GraphViewport;
  activeRound: ActivationPathLogRound | null;
  activatedNodes: Set<string>;
  progress: number;
}) {
  const { context, snapshot, positions, width, height, viewport, activeRound, activatedNodes, progress } = input;

  context.clearRect(0, 0, width, height);
  if (!snapshot) {
    return;
  }

  const activeEdgeKeys = new Set(activeRound?.propagated.map((entry) => `${entry.from}->${entry.to}`) ?? []);
  const frontierNodes = new Set(activeRound?.frontier.map((entry) => entry.node_id) ?? []);
  const targetNodes = new Set(activeRound?.propagated.map((entry) => entry.to) ?? []);

  context.lineCap = "round";
  context.save();
  context.translate(viewport.offsetX, viewport.offsetY);
  context.scale(viewport.scale, viewport.scale);

  for (const edge of snapshot.graph.edges) {
    const source = positions[edge.source];
    const target = positions[edge.target];
    if (!source || !target) {
      continue;
    }

    const isActive = activeEdgeKeys.has(`${edge.source}->${edge.target}`);
    const isVisited = activatedNodes.has(edge.source) && activatedNodes.has(edge.target);

    context.strokeStyle = isActive
      ? "rgba(56, 189, 248, 0.9)"
      : isVisited
        ? "rgba(148, 163, 184, 0.52)"
        : "rgba(156, 163, 175, 0.24)";
    context.lineWidth = isActive ? 2.5 + edge.weight * 2.5 : 1 + edge.weight * 1.8;
    context.beginPath();
    context.moveTo(source.x, source.y);
    context.lineTo(target.x, target.y);
    context.stroke();

    if (isActive) {
      const pulseX = source.x + (target.x - source.x) * progress;
      const pulseY = source.y + (target.y - source.y) * progress;
      context.fillStyle = "rgba(125, 211, 252, 0.96)";
      context.beginPath();
      context.arc(pulseX, pulseY, 4.5, 0, Math.PI * 2);
      context.fill();
    }
  }

  for (const node of snapshot.graph.nodes) {
    const position = positions[node.id];
    if (!position) {
      continue;
    }

    const radius = 8 + Math.min(32, node.activation_level * 32);
    const isFrontier = frontierNodes.has(node.id);
    const isTarget = targetNodes.has(node.id);
    const isVisited = activatedNodes.has(node.id);

    if (isVisited) {
      context.fillStyle = "rgba(125, 211, 252, 0.12)";
      context.beginPath();
      context.arc(position.x, position.y, radius + 10, 0, Math.PI * 2);
      context.fill();
    }

    if (isFrontier) {
      context.strokeStyle = "rgba(103, 232, 249, 0.98)";
      context.lineWidth = 3;
      context.beginPath();
      context.arc(position.x, position.y, radius + 7, 0, Math.PI * 2);
      context.stroke();
    }

    if (isTarget) {
      context.strokeStyle = `rgba(125, 211, 252, ${0.36 + progress * 0.42})`;
      context.lineWidth = 2.5;
      context.beginPath();
      context.arc(position.x, position.y, radius + 4 + progress * 8, 0, Math.PI * 2);
      context.stroke();
    }

    context.fillStyle = NODE_COLORS[node.type];
    context.beginPath();
    context.arc(position.x, position.y, radius, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = "rgba(15, 23, 42, 0.34)";
    context.lineWidth = 1.2;
    context.stroke();
  }

  context.restore();
}

function computeGraphBounds(input: {
  snapshot: CognitionDebugSnapshot | null;
  positions: Record<string, { x: number; y: number }>;
}) {
  const { snapshot, positions } = input;
  if (!snapshot || snapshot.graph.nodes.length === 0) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const node of snapshot.graph.nodes) {
    const position = positions[node.id];
    if (!position) {
      continue;
    }

    const radius = nodeRenderRadius(node) + 14;
    minX = Math.min(minX, position.x - radius);
    minY = Math.min(minY, position.y - radius);
    maxX = Math.max(maxX, position.x + radius);
    maxY = Math.max(maxY, position.y + radius);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null;
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2
  };
}

function fitGraphViewport(input: {
  snapshot: CognitionDebugSnapshot | null;
  positions: Record<string, { x: number; y: number }>;
  width: number;
  height: number;
  padding?: number;
}): GraphViewport {
  const { snapshot, positions, width, height, padding = 56 } = input;
  const bounds = computeGraphBounds({ snapshot, positions });
  if (!bounds || width <= 0 || height <= 0) {
    return {
      scale: 1,
      offsetX: 0,
      offsetY: 0
    };
  }

  const availableWidth = Math.max(1, width - padding * 2);
  const availableHeight = Math.max(1, height - padding * 2);
  const scale = clamp(Math.min(availableWidth / bounds.width, availableHeight / bounds.height), 0.35, 3);

  return {
    scale,
    offsetX: width / 2 - bounds.centerX * scale,
    offsetY: height / 2 - bounds.centerY * scale
  };
}

function screenToWorld(input: {
  x: number;
  y: number;
  viewport: GraphViewport;
}) {
  return {
    x: (input.x - input.viewport.offsetX) / input.viewport.scale,
    y: (input.y - input.viewport.offsetY) / input.viewport.scale
  };
}

function buildGraphStructureKey(snapshot: CognitionDebugSnapshot | null): string {
  if (!snapshot) {
    return "";
  }

  const nodeIds = snapshot.graph.nodes.map((node) => node.id).sort().join("|");
  const edgeIds = snapshot.graph.edges
    .map((edge) => `${edge.source}->${edge.target}`)
    .sort()
    .join("|");

  return `${nodeIds}::${edgeIds}`;
}

const parameterGroups: ParameterGroupDefinition[] = [
  {
    id: "quick_toggles",
    title: "快速开关",
    description: "只保留影响整体行为的布尔控制项。",
    summaryIds: []
  },
  {
    id: "spreading_core",
    title: "扩散核心",
    description: "决定扩散强度、保留率和轮数。",
    summaryIds: ["spreading_factor", "retention_delta", "diffusion_max_depth"]
  },
  {
    id: "expression_loop",
    title: "表达与心跳",
    description: "控制表达频率和心跳节奏。",
    summaryIds: ["expression_activation_threshold", "expression_cooldown_minutes", "heartbeat_lambda_minutes"]
  },
  {
    id: "learning_broadcast",
    title: "学习与广播",
    description: "影响 Hebbian 学习、衰减和广播写回。",
    summaryIds: ["hebbian_learning_rate", "hebbian_passive_decay_rate", "workspace_broadcast_hebbian_rate"]
  },
  {
    id: "consolidation_archive",
    title: "整合与归档",
    description: "控制睡眠整合、聚类和冷区迁移。",
    summaryIds: [
      "consolidation_forget_threshold_days",
      "consolidation_cluster_similarity_threshold",
      "consolidation_replay_hebbian_rate"
    ]
  },
  {
    id: "advanced_experiments",
    title: "高级实验",
    description: "保留给实验性或低频调参场景。",
    summaryIds: ["sigmoid_theta", "lateral_inhibition_beta", "emotion_modulation_strength"]
  }
];

const toggleDefinitions: ToggleDefinition[] = [
  {
    id: "broadcast_enabled",
    group: "quick_toggles",
    label: "启用全局广播",
    compactLabel: "全局广播",
    description: "表达成功后将活跃快照写入工作空间。",
    referenceText: "workspace.broadcast_enabled",
    state: (cfg: CognitionConfig) =>
      ((cfg as unknown as { workspace?: { broadcast_enabled?: boolean } } | null)?.workspace?.broadcast_enabled ?? true) === true,
    update: (value: boolean) => ({ workspace: { broadcast_enabled: value } } as unknown as CognitionConfigPatch),
    summaryFormatter: (value: boolean) => (value ? "已开" : "已关")
  },
  {
    id: "consolidation_enabled",
    group: "quick_toggles",
    label: "启用睡眠整合",
    compactLabel: "睡眠整合",
    description: "允许系统在静默窗口内执行睡眠整合。",
    referenceText: "consolidation.enabled",
    state: (cfg: CognitionConfig) => (cfg.consolidation.enabled ?? true) === true,
    update: (value: boolean) => ({ consolidation: { enabled: value } } as CognitionConfigPatch),
    summaryFormatter: (value: boolean) => (value ? "已开" : "已关")
  }
];

const sliderDefinitions: SliderDefinition[] = [
  {
    id: "spreading_factor",
    group: "spreading_core",
    label: "扩散因子 S — SYNAPSE §3.2",
    compactLabel: "扩散 S",
    description: "控制扩散传播强度。",
    referenceText: "SYNAPSE §3.2",
    min: 0.1,
    max: 1,
    step: 0.05,
    state: (cfg: CognitionConfig) => cfg.spreading.spreading_factor,
    update: (value: number) => ({ spreading: { spreading_factor: value } }),
    summaryFormatter: (value: number) => value.toFixed(2)
  },
  {
    id: "retention_delta",
    group: "spreading_core",
    label: "自身保留率 δ — SYNAPSE §4.1",
    compactLabel: "保留率 δ",
    description: "激活在每一轮扩散中的保留比例。",
    referenceText: "SYNAPSE §4.1",
    min: 0.1,
    max: 0.9,
    step: 0.05,
    state: (cfg: CognitionConfig) => cfg.spreading.retention_delta,
    update: (value: number) => ({ spreading: { retention_delta: value } }),
    summaryFormatter: (value: number) => value.toFixed(2)
  },
  {
    id: "diffusion_max_depth",
    group: "spreading_core",
    label: "最大扩散轮数 T — SYNAPSE §3.2",
    compactLabel: "最大轮数 T",
    description: "限制一次扩散最多传播几轮。",
    referenceText: "SYNAPSE §3.2",
    min: 1,
    max: 5,
    step: 1,
    state: (cfg: CognitionConfig) => cfg.spreading.diffusion_max_depth,
    update: (value: number) => ({ spreading: { diffusion_max_depth: value } }),
    summaryFormatter: (value: number) => value.toFixed(0)
  },
  {
    id: "expression_activation_threshold",
    group: "expression_loop",
    label: "表达激活阈值",
    compactLabel: "表达阈值",
    description: "泡进入表达候选所需的最低激活。",
    referenceText: "expression.activation_threshold",
    min: 0.1,
    max: 0.9,
    step: 0.05,
    state: (cfg: CognitionConfig) => cfg.expression.activation_threshold,
    update: (value: number) => ({ expression: { activation_threshold: value } }),
    summaryFormatter: (value: number) => value.toFixed(2)
  },
  {
    id: "expression_cooldown_minutes",
    group: "expression_loop",
    label: "表达冷却时间（分钟）",
    compactLabel: "表达冷却",
    description: "限制连续表达的最短间隔。",
    referenceText: "expression.cooldown_minutes",
    min: 5,
    max: 120,
    step: 5,
    state: (cfg: CognitionConfig) => cfg.expression.cooldown_minutes,
    update: (value: number) => ({ expression: { cooldown_minutes: value } }),
    summaryFormatter: (value: number) => `${value.toFixed(0)} 分钟`
  },
  {
    id: "heartbeat_lambda_minutes",
    group: "expression_loop",
    label: "心跳均值（分钟）",
    compactLabel: "心跳均值",
    description: "控制子意识循环的平均节奏。",
    referenceText: "loop.heartbeat_lambda_minutes",
    min: 5,
    max: 60,
    step: 1,
    state: (cfg: CognitionConfig) => cfg.loop.heartbeat_lambda_minutes,
    update: (value: number) => ({ loop: { heartbeat_lambda_minutes: value } }),
    summaryFormatter: (value: number) => `${value.toFixed(0)} 分钟`
  },
  {
    id: "random_walk_probability",
    group: "expression_loop",
    label: "随机游走概率",
    compactLabel: "随机游走",
    description: "心跳时附加随机种子的概率。",
    referenceText: "triggers.random_walk_probability",
    min: 0,
    max: 0.5,
    step: 0.05,
    state: (cfg: CognitionConfig) => cfg.triggers.random_walk_probability,
    update: (value: number) => ({ triggers: { random_walk_probability: value } }),
    summaryFormatter: (value: number) => value.toFixed(2)
  },
  {
    id: "hebbian_learning_rate",
    group: "learning_broadcast",
    label: "Hebbian 学习率 η",
    compactLabel: "学习率 η",
    description: "共同激活时边权强化速度。",
    referenceText: "hebbian.learning_rate",
    min: 0.001,
    max: 0.2,
    step: 0.005,
    state: (cfg: CognitionConfig) => cfg.hebbian.learning_rate,
    update: (value: number) => ({ hebbian: { learning_rate: value } }),
    summaryFormatter: (value: number) => value.toFixed(3)
  },
  {
    id: "hebbian_passive_decay_rate",
    group: "learning_broadcast",
    label: "被动衰减率",
    compactLabel: "被动衰减",
    description: "每次心跳对全图边的自然遗忘。",
    referenceText: "hebbian.passive_decay_rate",
    min: 0,
    max: 0.01,
    step: 0.001,
    state: (cfg: CognitionConfig) => cfg.hebbian.passive_decay_rate,
    update: (value: number) => ({ hebbian: { passive_decay_rate: value } }),
    summaryFormatter: (value: number) => value.toFixed(3)
  },
  {
    id: "workspace_broadcast_hebbian_rate",
    group: "learning_broadcast",
    label: "广播 Hebbian 学习率",
    compactLabel: "广播学习率",
    description: "表达成功后对广播快照施加的额外强化。",
    referenceText: "workspace.broadcast_hebbian_rate",
    min: 0,
    max: 0.1,
    step: 0.005,
    state: (cfg: CognitionConfig) =>
      ((cfg as unknown as { workspace?: { broadcast_hebbian_rate?: number } }).workspace?.broadcast_hebbian_rate ?? 0.02),
    update: (value: number) => ({ workspace: { broadcast_hebbian_rate: value } } as unknown as CognitionConfigPatch),
    summaryFormatter: (value: number) => value.toFixed(3)
  },
  {
    id: "workspace_broadcast_emotion_alpha",
    group: "learning_broadcast",
    label: "广播情绪更新 α",
    compactLabel: "广播情绪 α",
    description: "表达成功后情绪状态的 EMA 更新强度。",
    referenceText: "workspace.broadcast_emotion_alpha",
    min: 0,
    max: 0.3,
    step: 0.01,
    state: (cfg: CognitionConfig) =>
      ((cfg as unknown as { workspace?: { broadcast_emotion_alpha?: number } }).workspace?.broadcast_emotion_alpha ?? 0.15),
    update: (value: number) => ({ workspace: { broadcast_emotion_alpha: value } } as unknown as CognitionConfigPatch),
    summaryFormatter: (value: number) => value.toFixed(2)
  },
  {
    id: "workspace_broadcast_prediction_weight",
    group: "learning_broadcast",
    label: "广播预测权重",
    compactLabel: "广播预测权重",
    description: "成功表达模式写入预测历史时的附加权重。",
    referenceText: "workspace.broadcast_prediction_weight",
    min: 1,
    max: 3,
    step: 0.1,
    state: (cfg: CognitionConfig) =>
      ((cfg as unknown as { workspace?: { broadcast_prediction_weight?: number } }).workspace?.broadcast_prediction_weight ?? 1.5),
    update: (value: number) => ({ workspace: { broadcast_prediction_weight: value } } as unknown as CognitionConfigPatch),
    summaryFormatter: (value: number) => value.toFixed(1)
  },
  {
    id: "consolidation_forget_threshold_days",
    group: "consolidation_archive",
    label: "遗忘阈值（天）",
    compactLabel: "遗忘阈值",
    description: "超过阈值且低价值的节点才会迁移到冷区。",
    referenceText: "consolidation.forget_threshold_days",
    min: 1,
    max: 30,
    step: 1,
    state: (cfg: CognitionConfig) => cfg.consolidation.forget_threshold_days,
    update: (value: number) => ({ consolidation: { forget_threshold_days: value } }),
    summaryFormatter: (value: number) => `${value.toFixed(0)} 天`
  },
  {
    id: "consolidation_cluster_similarity_threshold",
    group: "consolidation_archive",
    label: "抽象聚类阈值",
    compactLabel: "聚类阈值",
    description: "语义相似度超过该值时聚成摘要簇。",
    referenceText: "consolidation.cluster_similarity_threshold",
    min: 0.5,
    max: 0.95,
    step: 0.05,
    state: (cfg: CognitionConfig) => cfg.consolidation.cluster_similarity_threshold,
    update: (value: number) => ({ consolidation: { cluster_similarity_threshold: value } }),
    summaryFormatter: (value: number) => value.toFixed(2)
  },
  {
    id: "consolidation_replay_hebbian_rate",
    group: "consolidation_archive",
    label: "回放 Hebbian 学习率",
    compactLabel: "回放学习率",
    description: "睡眠回放阶段的温和强化速率。",
    referenceText: "consolidation.replay_hebbian_rate",
    min: 0,
    max: 0.1,
    step: 0.005,
    state: (cfg: CognitionConfig) => cfg.consolidation.replay_hebbian_rate,
    update: (value: number) => ({ consolidation: { replay_hebbian_rate: value } }),
    summaryFormatter: (value: number) => value.toFixed(3)
  },
  {
    id: "sigmoid_theta",
    group: "advanced_experiments",
    label: "Sigmoid 阈值 θ — SYNAPSE §3.2（第二阶段生效）",
    compactLabel: "Sigmoid θ",
    description: "第二阶段使用的 Sigmoid 门限。",
    referenceText: "SYNAPSE §3.2 · 第二阶段生效",
    min: 0.05,
    max: 0.8,
    step: 0.05,
    state: (cfg: CognitionConfig) => cfg.sigmoid.theta,
    update: (value: number) => ({ sigmoid: { theta: value } }),
    summaryFormatter: (value: number) => value.toFixed(2)
  },
  {
    id: "lateral_inhibition_beta",
    group: "advanced_experiments",
    label: "抑制强度 β — SYNAPSE §3.2（第二阶段生效）",
    compactLabel: "抑制 β",
    description: "第二阶段的侧向抑制强度。",
    referenceText: "SYNAPSE §3.2 · 第二阶段生效",
    min: 0,
    max: 0.5,
    step: 0.05,
    state: (cfg: CognitionConfig) => cfg.inhibition.lateral_inhibition_beta,
    update: (value: number) => ({ inhibition: { lateral_inhibition_beta: value } }),
    summaryFormatter: (value: number) => value.toFixed(2)
  },
  {
    id: "emotion_modulation_strength",
    group: "advanced_experiments",
    label: "情绪调制强度",
    compactLabel: "情绪调制",
    description: "控制情绪匹配对扩散边权的放大或抑制。",
    referenceText: "emotion.modulation_strength",
    min: 0,
    max: 0.5,
    step: 0.01,
    state: (cfg: CognitionConfig) =>
      ((cfg as unknown as { emotion?: { modulation_strength?: number } }).emotion?.modulation_strength ?? 0.25),
    update: (value: number) => ({ emotion: { modulation_strength: value } } as unknown as CognitionConfigPatch),
    summaryFormatter: (value: number) => value.toFixed(2)
  },
  {
    id: "prediction_surprise_bonus",
    group: "advanced_experiments",
    label: "预测惊喜加成",
    compactLabel: "惊喜加成",
    description: "偏离预期的节点额外激活加成。",
    referenceText: "prediction.surprise_bonus",
    min: 0,
    max: 0.3,
    step: 0.01,
    state: (cfg: CognitionConfig) =>
      ((cfg as unknown as { prediction?: { surprise_bonus?: number } }).prediction?.surprise_bonus ?? 0.15),
    update: (value: number) => ({ prediction: { surprise_bonus: value } } as unknown as CognitionConfigPatch),
    summaryFormatter: (value: number) => value.toFixed(2)
  },
  {
    id: "prediction_familiarity_penalty",
    group: "advanced_experiments",
    label: "预测熟悉惩罚",
    compactLabel: "熟悉惩罚",
    description: "高度可预测节点的抑制系数。",
    referenceText: "prediction.familiarity_penalty",
    min: 0,
    max: 0.3,
    step: 0.01,
    state: (cfg: CognitionConfig) =>
      ((cfg as unknown as { prediction?: { familiarity_penalty?: number } }).prediction?.familiarity_penalty ?? 0.1),
    update: (value: number) => ({ prediction: { familiarity_penalty: value } } as unknown as CognitionConfigPatch),
    summaryFormatter: (value: number) => value.toFixed(2)
  }
];

const formatTime = (value: number) => {
  try {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(
      new Date(value)
    );
  } catch {
    return value;
  }
};

const formatNumeric = (value: number | null | undefined, digits = 2) =>
  typeof value === "number" ? value.toFixed(digits) : "--";

function buildConfigPatchValue(base: unknown, current: unknown): unknown {
  if (Array.isArray(base) || Array.isArray(current)) {
    return JSON.stringify(base) === JSON.stringify(current) ? undefined : current;
  }

  if (typeof base === "object" && base !== null && typeof current === "object" && current !== null) {
    const next: Record<string, unknown> = {};
    const keys = new Set([
      ...Object.keys(base as Record<string, unknown>),
      ...Object.keys(current as Record<string, unknown>)
    ]);

    for (const key of keys) {
      const diff = buildConfigPatchValue(
        (base as Record<string, unknown>)[key],
        (current as Record<string, unknown>)[key]
      );
      if (diff !== undefined) {
        next[key] = diff;
      }
    }

    return Object.keys(next).length > 0 ? next : undefined;
  }

  return Object.is(base, current) ? undefined : current;
}

function buildConfigPatch(base: CognitionConfig, current: CognitionConfig): CognitionConfigPatch {
  return (buildConfigPatchValue(base, current) ?? {}) as CognitionConfigPatch;
}

function hasPatchChanges(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  return Object.keys(value as Record<string, unknown>).length > 0;
}

function groupSummaryText(groupId: ParameterGroupId, config: CognitionConfig): string[] {
  if (groupId === "quick_toggles") {
    return toggleDefinitions.map((toggle) => `${toggle.compactLabel} ${toggle.summaryFormatter(toggle.state(config))}`);
  }

  const group = parameterGroups.find((item) => item.id === groupId);
  if (!group) {
    return [];
  }

  return group.summaryIds
    .map((summaryId) => sliderDefinitions.find((slider) => slider.id === summaryId))
    .filter((slider): slider is SliderDefinition => Boolean(slider))
    .map((slider) => `${slider.compactLabel} ${slider.summaryFormatter(slider.state(config))}`);
}

function computeWeightStats(edges: MemoryEdge[]) {
  const weights = edges
    .map((edge) => edge.weight)
    .filter((weight) => Number.isFinite(weight))
    .sort((left, right) => left - right);

  if (weights.length === 0) {
    return {
      mean: 0,
      median: 0,
      std: 0,
      min: 0,
      max: 0
    };
  }

  const mean = weights.reduce((sum, weight) => sum + weight, 0) / weights.length;
  const variance =
    weights.reduce((sum, weight) => sum + (weight - mean) * (weight - mean), 0) / weights.length;
  const middle = Math.floor(weights.length / 2);
  const median =
    weights.length % 2 === 0 ? (weights[middle - 1] + weights[middle]) / 2 : weights[middle] ?? 0;

  return {
    mean,
    median,
    std: Math.sqrt(variance),
    min: weights[0] ?? 0,
    max: weights[weights.length - 1] ?? 0
  };
}

function buildWeightHistogram(edges: MemoryEdge[], binCount = 20) {
  const bins = Array.from({ length: binCount }, (_, index) => ({
    index,
    start: index / binCount,
    end: (index + 1) / binCount,
    count: 0
  }));

  for (const edge of edges) {
    const weight = clamp(edge.weight, 0, 1);
    const index = Math.min(binCount - 1, Math.floor(weight * binCount));
    bins[index]!.count += 1;
  }

  return bins.map((bin) => ({
    ...bin,
    color: d3.interpolateRgbBasis(["#34D399", "#FBBF24", "#EF4444"])(
      bin.index / Math.max(1, binCount - 1)
    )
  }));
}

function trendGlyph(value: number) {
  if (value > 0.0005) {
    return "↗";
  }
  if (value < -0.0005) {
    return "↘";
  }
  return "→";
}

function workspaceOf(snapshot: CognitionDebugSnapshot | null): CognitionWorkspaceSnapshot {
  return ((snapshot as unknown as { workspace?: CognitionWorkspaceSnapshot })?.workspace ?? {}) as CognitionWorkspaceSnapshot;
}

function formatSigned(value: number | null | undefined, digits = 2): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "--";
  }
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function resolveNodeLabel(input: {
  nodeId: string;
  labelById: Map<string, string>;
}): string {
  return input.labelById.get(input.nodeId) ?? input.nodeId;
}

function toEpochMs(input: string | number | null | undefined): number | null {
  if (typeof input === "number") {
    return Number.isFinite(input) ? input : null;
  }
  if (typeof input === "string") {
    const parsed = Date.parse(input);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function CognitionDebugPage() {
  const [snapshot, setSnapshot] = useState<CognitionDebugSnapshot | null>(null);
  const [configState, setConfigState] = useState<CognitionConfig | null>(null);
  const [activeBottomTab, setActiveBottomTab] = useState<BottomTabId>("timeline");
  const [isDetailsDrawerOpen, setIsDetailsDrawerOpen] = useState(false);
  const [isParameterModalOpen, setIsParameterModalOpen] = useState(false);
  const [expandedParameterGroup, setExpandedParameterGroup] = useState<ParameterGroupId | null>(null);
  const [draftConfig, setDraftConfig] = useState<CognitionConfig | null>(null);
  const [parameterApplyStatus, setParameterApplyStatus] = useState<"idle" | "pending" | "error">("idle");
  const [parameterApplyError, setParameterApplyError] = useState<string | null>(null);
  const [healthMetrics, setHealthMetrics] = useState<HealthMetrics | null>(null);
  const [broadcastHistory, setBroadcastHistory] = useState<BroadcastSummary[]>([]);
  const [consolidationReport, setConsolidationReport] = useState<ConsolidationReport | null>(null);
  const [consolidationHistory, setConsolidationHistory] = useState<ConsolidationReport[]>([]);
  const [archiveStats, setArchiveStats] = useState<ColdArchiveStats | null>(null);
  const [consolidationStatus, setConsolidationStatus] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [manualText, setManualText] = useState("中午吃什么");
  const [manualStatus, setManualStatus] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [graphViewport, setGraphViewport] = useState<GraphViewport>({
    scale: 1,
    offsetX: 0,
    offsetY: 0
  });
  const [isGraphPanning, setIsGraphPanning] = useState(false);
  const [hoveredNode, setHoveredNode] = useState<MemoryNode | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ x: number; y: number } | null>(null);
  const [selectedLog, setSelectedLog] = useState<ActivationLogEntry | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const nodePositionsRef = useRef<Record<string, { x: number; y: number }>>({});
  const graphLayoutSignatureRef = useRef<string>("");
  const graphViewportDirtyRef = useRef(false);
  const graphPanRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const playbackTimeoutRef = useRef<number | null>(null);
  const [playbackSession, setPlaybackSession] = useState<PlaybackSession | null>(null);
  const [playbackFrame, setPlaybackFrame] = useState<PlaybackFrame | null>(null);

  const loadSnapshot = useCallback(async () => {
    try {
      const next = await window.companion.getCognitionDebugSnapshot();
      setSnapshot(next);
      setConfigState(next.config);
    } catch (error) {
      // console.error(error);
    }
  }, []);

  const loadHealthMetrics = useCallback(async () => {
    try {
      const next = await window.companion.getCognitionHealthMetrics();
      setHealthMetrics(next);
    } catch {
      // ignore
    }
  }, []);

  const loadBroadcastHistory = useCallback(async () => {
    try {
      const next = await window.companion.getCognitionBroadcastHistory();
      setBroadcastHistory(next);
    } catch {
      setBroadcastHistory(broadcastHistoryOf(snapshot));
    }
  }, [snapshot]);

  const loadConsolidationReport = useCallback(async () => {
    try {
      const next = await window.companion.getCognitionConsolidationReport();
      setConsolidationReport(next);
    } catch {
      setConsolidationReport(null);
    }
  }, []);

  const loadConsolidationHistory = useCallback(async () => {
    try {
      const next = await window.companion.getCognitionConsolidationHistory();
      setConsolidationHistory(next);
    } catch {
      setConsolidationHistory([]);
    }
  }, []);

  const loadArchiveStats = useCallback(async () => {
    try {
      const next = await window.companion.getCognitionArchiveStats();
      setArchiveStats(next);
    } catch {
      setArchiveStats(null);
    }
  }, []);

  const refreshCognitionPanels = useCallback(async () => {
    await loadSnapshot();
    await loadHealthMetrics();
    await loadBroadcastHistory();
    await loadConsolidationReport();
    await loadConsolidationHistory();
    await loadArchiveStats();
  }, [
    loadArchiveStats,
    loadBroadcastHistory,
    loadConsolidationHistory,
    loadConsolidationReport,
    loadHealthMetrics,
    loadSnapshot
  ]);
  const graphStructureKey = useMemo(() => buildGraphStructureKey(snapshot), [snapshot]);

  useEffect(() => {
    void refreshCognitionPanels();
  }, [refreshCognitionPanels]);

  const startPlaybackFromEntry = useCallback((entry: ActivationLogEntry | null) => {
    const pathLog = entry?.path_log ?? [];
    if (pathLog.length === 0) {
      setPlaybackSession(null);
      setPlaybackFrame(null);
      return;
    }

    setPlaybackSession({
      timestamp: entry?.timestamp ?? Date.now(),
      pathLog
    });
  }, []);

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const bounds = entries[0]?.contentRect;
      if (bounds) {
        setSize({ width: bounds.width, height: bounds.height });
      }
    });
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!autoRefresh) {
      return () => undefined;
    }
    const unsubscribe = window.companion.onCognitionTickCompleted((entry) => {
      setSelectedLog(entry);
      startPlaybackFromEntry(entry);
      void refreshCognitionPanels();
    });
    return () => unsubscribe();
  }, [autoRefresh, refreshCognitionPanels, startPlaybackFromEntry]);

  useEffect(() => {
    if (!snapshot || !canvasRef.current || size.width === 0 || size.height === 0) {
      return;
    }

    const previousPositions = nodePositionsRef.current;
    const structureChanged = graphLayoutSignatureRef.current !== graphStructureKey;
    const hasAllPositions =
      snapshot.graph.nodes.length > 0 && snapshot.graph.nodes.every((node) => Boolean(previousPositions[node.id]));

    if (!structureChanged && hasAllPositions) {
      if (!graphViewportDirtyRef.current) {
        setGraphViewport(
          fitGraphViewport({
            snapshot,
            positions: previousPositions,
            width: size.width,
            height: size.height
          })
        );
      }
      return;
    }

    const nodes: GraphNode[] = snapshot.graph.nodes.map((node) => ({ ...node }));
    const links: GraphLink[] = snapshot.graph.edges.map((edge) => ({ ...edge }));

    nodes.forEach((node, index) => {
      const previous = previousPositions[node.id];
      if (previous) {
        node.x = previous.x;
        node.y = previous.y;
        return;
      }

      const angle = (Math.PI * 2 * index) / Math.max(1, nodes.length);
      const radius = 140 + (index % 3) * 28;
      node.x = Math.cos(angle) * radius;
      node.y = Math.sin(angle) * radius;
    });

    const simulation = d3
      .forceSimulation(nodes)
      .force(
        "link",
        d3
          .forceLink(links)
          .id((datum: GraphNode) => datum.id)
          .distance((link: GraphLink) => 120 - Math.min(50, link.weight * 40))
          .strength((link: GraphLink) => 0.16 + link.weight * 0.3)
      )
      .force("charge", d3.forceManyBody().strength(-150))
      .force("collision", d3.forceCollide().radius((node: GraphNode) => 30 + node.activation_level * 22))
      .force("center", d3.forceCenter(0, 0))
      .stop();

    for (let index = 0; index < 140; index += 1) {
      simulation.tick();
    }
    simulation.stop();

    const positions: Record<string, { x: number; y: number }> = {};
    nodes.forEach((node) => {
      positions[node.id] = {
        x: node.x ?? 0,
        y: node.y ?? 0
      };
    });
    nodePositionsRef.current = positions;
    graphLayoutSignatureRef.current = graphStructureKey;
    if (!graphViewportDirtyRef.current || structureChanged) {
      setGraphViewport(
        fitGraphViewport({
          snapshot,
          positions,
          width: size.width,
          height: size.height
        })
      );
    }
  }, [graphStructureKey, size, snapshot]);

  useEffect(() => {
    const context = canvasRef.current?.getContext("2d");
    if (!context || size.width === 0 || size.height === 0) {
      return;
    }

    const activeRound =
      playbackSession && playbackFrame
        ? playbackSession.pathLog[playbackFrame.roundIndex] ?? null
        : null;
    const activatedNodes = new Set<string>();
    if (playbackSession && playbackFrame) {
      for (let index = 0; index <= playbackFrame.roundIndex; index += 1) {
        const round = playbackSession.pathLog[index];
        round?.frontier.forEach((item) => activatedNodes.add(item.node_id));
        round?.propagated.forEach((item) => {
          activatedNodes.add(item.from);
          activatedNodes.add(item.to);
        });
      }
    }

    drawGraphCanvas({
      context,
      snapshot,
      positions: nodePositionsRef.current,
      width: size.width,
      height: size.height,
      viewport: graphViewport,
      activeRound,
      activatedNodes,
      progress: playbackFrame?.progress ?? 0
    });
  }, [graphViewport, playbackFrame, playbackSession, size, snapshot]);

  useEffect(() => {
    if (playbackTimeoutRef.current !== null) {
      window.clearTimeout(playbackTimeoutRef.current);
      playbackTimeoutRef.current = null;
    }

    if (!playbackSession || playbackSession.pathLog.length === 0) {
      setPlaybackFrame(null);
      return;
    }

    let cancelled = false;
    let frameId = 0;
    const roundDurationMs = 700;
    const roundPauseMs = 120;

    const animateRound = (roundIndex: number) => {
      if (cancelled) {
        return;
      }

      if (roundIndex >= playbackSession.pathLog.length) {
        setPlaybackFrame({
          roundIndex: playbackSession.pathLog.length - 1,
          progress: 1
        });
        return;
      }

      const startedAt = performance.now();
      const step = (timestamp: number) => {
        if (cancelled) {
          return;
        }

        const progress = clamp((timestamp - startedAt) / roundDurationMs, 0, 1);
        setPlaybackFrame({
          roundIndex,
          progress
        });

        if (progress < 1) {
          frameId = window.requestAnimationFrame(step);
          return;
        }

        playbackTimeoutRef.current = window.setTimeout(() => {
          animateRound(roundIndex + 1);
        }, roundPauseMs);
      };

      frameId = window.requestAnimationFrame(step);
    };

    animateRound(0);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
      if (playbackTimeoutRef.current !== null) {
        window.clearTimeout(playbackTimeoutRef.current);
        playbackTimeoutRef.current = null;
      }
    };
  }, [playbackSession]);

  const handleMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (isGraphPanning) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const world = screenToWorld({
      x,
      y,
      viewport: graphViewport
    });
    let closest: MemoryNode | null = null;
    let minDistance = Infinity;
    const nodes = snapshot?.graph.nodes ?? [];
    nodes.forEach((node) => {
      const pos = nodePositionsRef.current[node.id];
      if (!pos) {
        return;
      }
      const distance = Math.hypot(pos.x - world.x, pos.y - world.y);
      if (distance < minDistance && distance < 28 / graphViewport.scale) {
        closest = node;
        minDistance = distance;
      }
    });
    if (closest) {
      setHoveredNode(closest);
      setTooltipPosition({ x, y });
    } else {
      setHoveredNode(null);
      setTooltipPosition(null);
    }
  };

  const handleManualSpread = async () => {
    if (!manualText.trim()) {
      return;
    }
    setManualStatus("pending");
    try {
      const result = await window.companion.triggerCognitionManualSpread({ text: manualText });
      setManualStatus("success");
      setSnapshot(result.snapshot);
      setConfigState(result.snapshot.config);
      setBroadcastHistory(broadcastHistoryOf(result.snapshot));
      setSelectedLog(result.entry);
      startPlaybackFromEntry(result.entry);
      await loadHealthMetrics();
      await loadConsolidationReport();
      await loadConsolidationHistory();
      await loadArchiveStats();
    } catch (error) {
      setManualStatus("error");
    }
  };

  const handleManualConsolidation = async () => {
    setConsolidationStatus("pending");
    try {
      const report = await window.companion.triggerCognitionConsolidation();
      setConsolidationStatus("success");
      setConsolidationReport(report);
      await loadSnapshot();
      await loadHealthMetrics();
      await loadConsolidationHistory();
      await loadArchiveStats();
    } catch {
      setConsolidationStatus("error");
    }
  };

  const mergeConfig = (base: CognitionConfig, partial: CognitionConfigPatch): CognitionConfig => {
    const merged = {
      ...base,
      spreading: {
        ...base.spreading,
        ...(partial.spreading ?? {})
      },
      sigmoid: {
        ...base.sigmoid,
        ...(partial.sigmoid ?? {})
      },
      inhibition: {
        ...base.inhibition,
        ...(partial.inhibition ?? {})
      },
      actr: {
        ...base.actr,
        ...(partial.actr ?? {})
      },
      hebbian: {
        ...base.hebbian,
        ...(partial.hebbian ?? {})
      },
      expression: {
        ...base.expression,
        ...(partial.expression ?? {})
      },
      graph_maintenance: {
        ...base.graph_maintenance,
        ...(partial.graph_maintenance ?? {})
      },
      loop: {
        ...base.loop,
        ...(partial.loop ?? {}),
        active_hours: {
          ...base.loop.active_hours,
          ...(partial.loop?.active_hours ?? {})
        }
      },
      triggers: {
        ...base.triggers,
        ...(partial.triggers ?? {})
      },
      workspace: {
        ...((base as unknown as { workspace?: CognitionConfig["workspace"] }).workspace ?? DEFAULT_COGNITION_CONFIG.workspace),
        ...((partial as unknown as { workspace?: Partial<CognitionConfig["workspace"]> }).workspace ?? {})
      },
      consolidation: {
        ...base.consolidation,
        ...(partial.consolidation ?? {})
      }
    };
    const asBase = base as unknown as Record<string, unknown>;
    const asPatch = partial as unknown as Record<string, unknown>;
    const asMerged = merged as unknown as Record<string, unknown>;
    if (typeof asPatch.emotion === "object" && asPatch.emotion !== null) {
      asMerged.emotion = {
        ...(typeof asBase.emotion === "object" && asBase.emotion !== null ? asBase.emotion : {}),
        ...asPatch.emotion as Record<string, unknown>
      };
    }
    if (typeof asPatch.prediction === "object" && asPatch.prediction !== null) {
      asMerged.prediction = {
        ...(typeof asBase.prediction === "object" && asBase.prediction !== null ? asBase.prediction : {}),
        ...asPatch.prediction as Record<string, unknown>
      };
    }
    if (typeof asPatch.attention === "object" && asPatch.attention !== null) {
      asMerged.attention = {
        ...(typeof asBase.attention === "object" && asBase.attention !== null ? asBase.attention : {}),
        ...asPatch.attention as Record<string, unknown>
      };
    }
    if (typeof asPatch.workspace === "object" && asPatch.workspace !== null) {
      asMerged.workspace = {
        ...(typeof asBase.workspace === "object" && asBase.workspace !== null ? asBase.workspace : {}),
        ...asPatch.workspace as Record<string, unknown>
      };
    }
    return merged;
  };

  const handleOpenParameterModal = useCallback(() => {
    if (!configState) {
      return;
    }

    setDraftConfig(configState);
    setExpandedParameterGroup(null);
    setParameterApplyStatus("idle");
    setParameterApplyError(null);
    setIsParameterModalOpen(true);
  }, [configState]);

  const resetParameterDraft = useCallback(() => {
    setDraftConfig(null);
    setExpandedParameterGroup(null);
    setParameterApplyStatus("idle");
    setParameterApplyError(null);
  }, []);

  const handleCancelParameterModal = useCallback(() => {
    if (parameterApplyStatus === "pending") {
      return;
    }

    setIsParameterModalOpen(false);
    resetParameterDraft();
  }, [parameterApplyStatus, resetParameterDraft]);

  const draftPatch = useMemo(
    () => (configState && draftConfig ? buildConfigPatch(configState, draftConfig) : ({} as CognitionConfigPatch)),
    [configState, draftConfig]
  );
  const hasDraftChanges = useMemo(() => hasPatchChanges(draftPatch), [draftPatch]);

  const handleDraftPatch = useCallback(
    (partial: CognitionConfigPatch) => {
      setDraftConfig((current) => (current ? mergeConfig(current, partial) : current));
      setParameterApplyStatus("idle");
      setParameterApplyError(null);
    },
    []
  );

  const handleDraftSlider = useCallback(
    (update: (value: number) => CognitionConfigPatch, value: number) => {
      handleDraftPatch(update(value));
    },
    [handleDraftPatch]
  );

  const handleDraftToggle = useCallback(
    (update: (value: boolean) => CognitionConfigPatch, value: boolean) => {
      handleDraftPatch(update(value));
    },
    [handleDraftPatch]
  );

  const handleCanvasMouseDown = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) {
      return;
    }

    graphPanRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: graphViewport.offsetX,
      originY: graphViewport.offsetY
    };
    graphViewportDirtyRef.current = true;
    setIsGraphPanning(true);
    setHoveredNode(null);
    setTooltipPosition(null);
    event.preventDefault();
  }, [graphViewport.offsetX, graphViewport.offsetY]);

  const handleCanvasWheel = useCallback((event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left;
    const pointerY = event.clientY - bounds.top;
    const looksLikeTrackpadScroll =
      event.deltaMode === WheelEvent.DOM_DELTA_PIXEL && (Math.abs(event.deltaX) > 0 || Math.abs(event.deltaY) < 40);
    const shouldZoom = event.ctrlKey || event.metaKey || !looksLikeTrackpadScroll;

    if (shouldZoom) {
      const zoomFactor = Math.exp(-event.deltaY * 0.0015);

      setGraphViewport((current) => {
        const nextScale = clamp(current.scale * zoomFactor, 0.35, 6);
        const world = screenToWorld({
          x: pointerX,
          y: pointerY,
          viewport: current
        });

        return {
          scale: nextScale,
          offsetX: pointerX - world.x * nextScale,
          offsetY: pointerY - world.y * nextScale
        };
      });
    } else {
      setGraphViewport((current) => ({
        ...current,
        offsetX: current.offsetX - event.deltaX,
        offsetY: current.offsetY - event.deltaY
      }));
    }

    graphViewportDirtyRef.current = true;
    setHoveredNode(null);
    setTooltipPosition(null);
  }, []);

  const handleResetGraphViewport = useCallback(() => {
    graphViewportDirtyRef.current = false;
    setGraphViewport(
      fitGraphViewport({
        snapshot,
        positions: nodePositionsRef.current,
        width: size.width,
        height: size.height
      })
    );
    setHoveredNode(null);
    setTooltipPosition(null);
  }, [size.height, size.width, snapshot]);

  const handleApplyParameterDraft = useCallback(async () => {
    if (!configState || !draftConfig || !hasDraftChanges || parameterApplyStatus === "pending") {
      return;
    }

    setParameterApplyStatus("pending");
    setParameterApplyError(null);

    try {
      const nextConfig = await window.companion.updateCognitionConfig(draftPatch);
      setConfigState(nextConfig);
      setIsParameterModalOpen(false);
      resetParameterDraft();
      await refreshCognitionPanels();
    } catch (error) {
      setParameterApplyStatus("error");
      setParameterApplyError(error instanceof Error ? error.message : "参数应用失败，请稍后重试。");
    }
  }, [
    configState,
    draftConfig,
    draftPatch,
    hasDraftChanges,
    parameterApplyStatus,
    refreshCognitionPanels,
    resetParameterDraft
  ]);

  useEffect(() => {
    if (!isParameterModalOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isParameterModalOpen]);

  useEffect(() => {
    if (!isParameterModalOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      if (hasDraftChanges || parameterApplyStatus === "pending") {
        return;
      }

      handleCancelParameterModal();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleCancelParameterModal, hasDraftChanges, isParameterModalOpen, parameterApplyStatus]);


  useEffect(() => {
    if (!isGraphPanning) {
      return;
    }

    const handleMouseMove = (event: MouseEvent) => {
      const pan = graphPanRef.current;
      if (!pan) {
        return;
      }

      setGraphViewport((current) => ({
        ...current,
        offsetX: pan.originX + (event.clientX - pan.startX),
        offsetY: pan.originY + (event.clientY - pan.startY)
      }));
    };

    const handleMouseUp = () => {
      graphPanRef.current = null;
      setIsGraphPanning(false);
    };

    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isGraphPanning]);

  const logDots = useMemo(() => snapshot?.lastLogs ?? [], [snapshot]);
  const effectiveBroadcastHistory = useMemo(
    () => (broadcastHistory.length > 0 ? broadcastHistory : broadcastHistoryOf(snapshot)),
    [broadcastHistory, snapshot]
  );
  const hotZoneRatio = useMemo(() => {
    if (!snapshot || !configState) {
      return 0;
    }
    return snapshot.graph.stats.node_count / Math.max(1, configState.consolidation.hot_node_limit);
  }, [configState, snapshot]);

  const timelineBounds = useMemo(() => {
    const logs = logDots.filter((log) => log.timestamp);
    if (logs.length === 0) {
      return { min: 0, max: 1 };
    }
    const times = logs.map((log) => new Date(log.timestamp).getTime());
    return { min: Math.min(...times), max: Math.max(...times) };
  }, [logDots]);

  const timelineWidth = 320;
  const timelineHeight = 100;

  const timelineColor = (log: ActivationLogEntry) => {
    if (log.broadcast_result) {
      return "#D4A017";
    }
    if (log.expression_produced) {
      return "#34D399";
    }
    if (log.bubbles_generated > 0) {
      return "#F59E0B";
    }
    return "#9CA3AF";
  };

  const stats = snapshot?.graph.stats ?? {
    node_count: snapshot?.graph.nodes.length ?? 0,
    edge_count: snapshot?.graph.edges.length ?? 0,
    avg_activation:
      (snapshot?.graph.nodes.reduce((sum, node) => sum + node.activation_level, 0) ?? 0) /
        Math.max(1, snapshot?.graph.nodes.length ?? 0)
  };
  const activeRoundLabel =
    playbackSession && playbackFrame
      ? `传播回放 ${playbackFrame.roundIndex + 1}/${playbackSession.pathLog.length}`
      : null;
  const experimentLogs = useMemo(
    () =>
      [...(snapshot?.lastLogs ?? [])]
        .filter((entry) => entry.trigger_type === "manual_signal" || Boolean(entry.manual_text))
        .sort((left, right) => right.timestamp - left.timestamp),
    [snapshot]
  );
  const nodeLabelById = useMemo(() => {
    const labelById = new Map<string, string>();
    for (const node of snapshot?.graph.nodes ?? []) {
      labelById.set(node.id, node.content);
    }
    return labelById;
  }, [snapshot]);
  const latestGraphLog = useMemo(
    () => (snapshot?.lastLogs?.length ? snapshot.lastLogs[snapshot.lastLogs.length - 1] ?? null : null),
    [snapshot]
  );
  const weightStats = useMemo(
    () => computeWeightStats(snapshot?.graph.edges ?? []),
    [snapshot]
  );
  const weightHistogram = useMemo(
    () => buildWeightHistogram(snapshot?.graph.edges ?? []),
    [snapshot]
  );
  const maxHistogramCount = useMemo(
    () => Math.max(1, ...weightHistogram.map((bin) => bin.count)),
    [weightHistogram]
  );
  const healthSummary = healthMetrics;
  const workspace = useMemo(() => workspaceOf(snapshot), [snapshot]);
  const emotionSnapshot = workspace.emotion ?? null;
  const predictionSnapshot = workspace.prediction ?? null;
  const attentionSnapshot = workspace.attention ?? null;
  const predictionWarmupProgress = predictionSnapshot?.progress ?? null;
  const focusNodeIds = attentionSnapshot?.focus_node_ids ?? [];
  const emotionUpdatedAt = toEpochMs(emotionSnapshot?.last_updated ?? null);
  const surprisingNodeLabels = (predictionSnapshot?.surprising_node_ids ?? [])
    .slice(0, 5)
    .map((nodeId) => resolveNodeLabel({ nodeId, labelById: nodeLabelById }));
  const familiarNodeLabels = (predictionSnapshot?.familiar_node_ids ?? [])
    .slice(0, 5)
    .map((nodeId) => resolveNodeLabel({ nodeId, labelById: nodeLabelById }));
  const selectedRoundRows = useMemo(
    () =>
      buildRoundStageRows({
        pathLog: selectedLog?.path_log,
        labelById: nodeLabelById
      }),
    [nodeLabelById, selectedLog]
  );
  const parameterModalConfig = draftConfig ?? configState ?? DEFAULT_COGNITION_CONFIG;
  const alertCount = healthSummary?.alerts.length ?? 0;
  const overviewItems = [
    {
      label: "运行健康",
      value: `${formatNumeric(healthSummary?.uptime_hours)}h`,
      detail: `${alertCount} 条告警`
    },
    {
      label: "心跳节奏",
      value: `${healthSummary?.total_ticks ?? 0} 次`,
      detail: `均值 ${formatNumeric((healthSummary?.heartbeat_stats.avg_interval_actual_ms ?? 0) / 60000)} 分钟`
    },
    {
      label: "表达表现",
      value: `${formatNumeric((healthSummary?.expression_ratio ?? 0) * 100)}%`,
      detail: `空 tick ${formatNumeric((healthSummary?.empty_tick_ratio ?? 0) * 100)}%`
    },
    {
      label: "图压力",
      value: `${stats.node_count ?? 0} / ${stats.edge_count ?? 0}`,
      detail: `热区 ${formatNumeric(hotZoneRatio * 100)}%`
    },
    {
      label: "权重趋势",
      value: formatNumeric(healthSummary?.weight_mean_current),
      detail: `${trendGlyph(healthSummary?.weight_mean_trend ?? 0)} ${formatNumeric(healthSummary?.weight_mean_trend, 4)}`
    }
  ];
  const alertBannerTone =
    alertCount > 0
      ? healthSummary?.alerts.some((alert) => alert.level === "error")
        ? "status-surface--danger"
        : "status-surface--warn"
      : "status-surface--success";
  const alertBannerText =
    alertCount > 0
      ? healthSummary?.alerts.slice(0, 2).map((alert) => alert.msg).join(" · ")
      : "当前没有健康告警，页面已切换为总览优先布局。";
  const bottomTabMeta: Array<{ id: BottomTabId; label: string; helper: string }> = [
    {
      id: "timeline",
      label: "心跳日志",
      helper: "时间线 + 当前选中详情"
    },
    {
      id: "experiments",
      label: "扩散评估",
      helper: "手动扩散记录与参数对比"
    }
  ];
  const selectedLogDetails = selectedLog ? (
    <div className="space-y-2 text-xs text-slate-700">
      <div className="grid gap-2 sm:grid-cols-2">
        <div>时间：{formatTime(selectedLog.timestamp)}</div>
        <div>触发：{selectedLog.trigger_type}</div>
        {selectedLog.duration_ms != null ? <div>耗时：{selectedLog.duration_ms} ms</div> : null}
        {selectedLog.evaluation_score != null ? <div>评分：{selectedLog.evaluation_score.toFixed(2)}</div> : null}
      </div>
      {selectedLog.trigger_sources?.length ? (
        <div>
          触发源：
          {selectedLog.trigger_sources
            .map((source) => `${source.type} · ${source.source_description}`)
            .join(" | ")}
        </div>
      ) : null}
      <div>种子：{selectedLog.seeds.map((seed) => seed.label).join(", ")}</div>
      <div>
        Top 节点：
        {selectedLog.top_activated
          .slice(0, 5)
          .map((node) => `${node.label} (${node.activation.toFixed(2)})`)
          .join(" · ")}
      </div>
      {selectedLog.bubble_summary ? <div>泡：{selectedLog.bubble_summary}</div> : null}
      {selectedLog.expression_text ? <div>表达：{selectedLog.expression_text}</div> : null}
      {selectedRoundRows.length > 0 ? (
        <details className="rounded-md border border-border/60 bg-white/70 px-2 py-1">
          <summary className="cursor-pointer select-none font-medium text-slate-900">
            三阶段详情（每轮 Top）
          </summary>
          <div className="mt-2 space-y-2">
            {selectedRoundRows.map((round) => (
              <div key={`selected-round-${selectedLog.timestamp}-${round.depth}`} className="rounded-md border border-border/50 bg-white/80 p-2">
                <div className="font-medium text-slate-900">Round {round.depth}</div>
                <div className="mt-1 text-slate-700">Propagation: {round.propagation}</div>
                <div className="text-slate-700">Inhibition: {round.inhibition}</div>
                <div className="text-slate-700">Sigmoid: {round.sigmoid}</div>
                {round.trimmed ? <div className="text-slate-700">Trimmed: {round.trimmed}</div> : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}
      {selectedLog.hebbian_log ? (
        <details className="rounded-md border border-border/60 bg-white/70 px-2 py-1">
          <summary className="cursor-pointer select-none font-medium text-slate-900">
            Hebbian 更新
          </summary>
          <div className="mt-2 space-y-2 text-slate-700">
            <div>
              本轮更新 {selectedLog.hebbian_log.edges_updated} 条边 | 强化 {selectedLog.hebbian_log.edges_strengthened} |
              弱化 {selectedLog.hebbian_log.edges_weakened} | 归一化触发 {selectedLog.hebbian_log.normalization_triggered_nodes} 节点
            </div>
            <div>
              权重: avg={formatNumeric(selectedLog.hebbian_log.avg_weight_after)} max=
              {formatNumeric(selectedLog.hebbian_log.max_weight_after)} min=
              {formatNumeric(selectedLog.hebbian_log.min_weight_after)}
            </div>
            <div>
              <div className="font-medium text-slate-900">最大强化 Top 3</div>
              {selectedLog.hebbian_log.top_strengthened.length > 0 ? (
                selectedLog.hebbian_log.top_strengthened.map((change, index) => (
                  <div key={`selected-strengthened-${index}`}>
                    "{change.source_content}" → "{change.target_content}" {formatNumeric(change.weight_before)} →{" "}
                    {formatNumeric(change.weight_after)} ({change.delta >= 0 ? "+" : ""}
                    {formatNumeric(change.delta)})
                  </div>
                ))
              ) : (
                <div>无</div>
              )}
            </div>
            <div>
              <div className="font-medium text-slate-900">最大弱化 Top 3</div>
              {selectedLog.hebbian_log.top_weakened.length > 0 ? (
                selectedLog.hebbian_log.top_weakened.map((change, index) => (
                  <div key={`selected-weakened-${index}`}>
                    "{change.source_content}" → "{change.target_content}" {formatNumeric(change.weight_before)} →{" "}
                    {formatNumeric(change.weight_after)} ({change.delta >= 0 ? "+" : ""}
                    {formatNumeric(change.delta)})
                  </div>
                ))
              ) : (
                <div>无</div>
              )}
            </div>
          </div>
        </details>
      ) : null}
      {selectedLog.graph_stats ? (
        <div className="rounded-md border border-border/60 bg-slate-50/80 px-2 py-2 text-slate-700">
          图统计：avg={formatNumeric(selectedLog.graph_stats.avg_weight)} median=
          {formatNumeric(selectedLog.graph_stats.median_weight)} std=
          {formatNumeric(selectedLog.graph_stats.std_weight)} min=
          {formatNumeric(selectedLog.graph_stats.min_weight)} max=
          {formatNumeric(selectedLog.graph_stats.max_weight)}
        </div>
      ) : null}
      {selectedLog.broadcast_result ? (
        <details className="rounded-md border border-amber-300 bg-amber-50/70 px-2 py-1">
          <summary className="cursor-pointer select-none font-medium text-amber-950">
            全局广播
          </summary>
          <div className="mt-2 space-y-2 text-slate-700">
            <div>广播 ID：{selectedLog.broadcast_result.broadcast_id}</div>
            <div>快照节点数：{selectedLog.broadcast_result.packet.activation_snapshot.length}</div>
            <div>
              广播情绪：V {formatSigned(selectedLog.broadcast_result.packet.emotion_at_broadcast.valence)} · A{" "}
              {formatNumeric(selectedLog.broadcast_result.packet.emotion_at_broadcast.arousal)}
            </div>
            {selectedLog.broadcast_result.hebbian_report ? (
              <div className={selectedLog.broadcast_result.hebbian_report.overlap_warning ? "rounded-md border border-amber-400 bg-amber-100 px-2 py-2" : ""}>
                Hebbian：更新 {selectedLog.broadcast_result.hebbian_report.updated_edges_count} 条边，最大单 tick delta{" "}
                {formatNumeric(selectedLog.broadcast_result.hebbian_report.max_single_tick_delta)}
                {selectedLog.broadcast_result.hebbian_report.overlap_warning ? " · overlap warning" : ""}
              </div>
            ) : null}
            {selectedLog.broadcast_result.emotion_report?.details ? (
              <div>
                情绪更新：V {formatNumeric(Number(selectedLog.broadcast_result.emotion_report.details.before_valence ?? 0))} →{" "}
                {formatNumeric(Number(selectedLog.broadcast_result.emotion_report.details.after_valence ?? 0))}，A{" "}
                {formatNumeric(Number(selectedLog.broadcast_result.emotion_report.details.before_arousal ?? 0))} →{" "}
                {formatNumeric(Number(selectedLog.broadcast_result.emotion_report.details.after_arousal ?? 0))}
              </div>
            ) : null}
            {selectedLog.broadcast_result.prediction_report?.details ? (
              <div>
                预测权重：{formatNumeric(Number(selectedLog.broadcast_result.prediction_report.details.weight ?? 0))}
                {" · "}历史 {String(selectedLog.broadcast_result.prediction_report.details.history_progress_before ?? "--")} →{" "}
                {String(selectedLog.broadcast_result.prediction_report.details.history_progress_after ?? "--")}
              </div>
            ) : null}
            {selectedLog.broadcast_result.attention_report?.details ? (
              <div>
                新焦点：{Array.isArray(selectedLog.broadcast_result.attention_report.details.focus_node_ids)
                  ? (selectedLog.broadcast_result.attention_report.details.focus_node_ids as unknown[])
                    .map((nodeId) => resolveNodeLabel({ nodeId: String(nodeId), labelById: nodeLabelById }))
                    .join(" · ")
                  : "无"}
              </div>
            ) : null}
            {selectedLog.broadcast_result.errors.length > 0 ? (
              <div className="rounded-md border border-rose-300 bg-rose-50 px-2 py-2">
                {selectedLog.broadcast_result.errors.map((error, index) => (
                  <div key={`broadcast-error-${index}`}>
                    {error.module_name}: {error.message}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  ) : (
    <p className="text-xs text-muted-foreground">悬浮看详情，点击圆点回放某一轮扩散。</p>
  );
  const timelinePanel = (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border/60 bg-white/75 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-foreground">扩散时间线</div>
            <div className="text-xs text-muted-foreground">点击圆点即可回放该轮扩散，并在下方查看详情。</div>
          </div>
          <div className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700">
            {logDots.length} 条
          </div>
        </div>
        <svg width="100%" height={timelineHeight} viewBox={`0 0 ${timelineWidth} ${timelineHeight}`}>
          <line
            x1={0}
            x2={timelineWidth}
            y1={timelineHeight / 2}
            y2={timelineHeight / 2}
            stroke="#E5E7EB"
            strokeWidth={2}
          />
          {logDots.map((log, index) => {
            const time = new Date(log.timestamp).getTime() || 0;
            const x =
              timelineBounds.max === timelineBounds.min
                ? timelineWidth / 2
                : ((time - timelineBounds.min) / Math.max(1, timelineBounds.max - timelineBounds.min)) * timelineWidth;
            const commonProps = {
              onMouseEnter: () => setSelectedLog(log),
              onMouseLeave: () => setSelectedLog(null),
              onClick: () => {
                setSelectedLog(log);
                startPlaybackFromEntry(log);
              },
              style: { cursor: "pointer" }
            };
            if (log.broadcast_result) {
              const rOuter = 8;
              const rInner = 4;
              const starPoints = Array.from({ length: 10 }, (_, pointIndex) => {
                const angle = (-Math.PI / 2) + (pointIndex * Math.PI) / 5;
                const radius = pointIndex % 2 === 0 ? rOuter : rInner;
                return `${x + Math.cos(angle) * radius},${timelineHeight / 2 + Math.sin(angle) * radius}`;
              }).join(" ");
              return (
                <polygon
                  key={`${log.timestamp}-${index}`}
                  points={starPoints}
                  fill={timelineColor(log)}
                  stroke="#7c5e10"
                  strokeWidth={1}
                  {...commonProps}
                />
              );
            }
            return (
              <circle
                key={`${log.timestamp}-${index}`}
                cx={x}
                cy={timelineHeight / 2}
                r={6}
                fill={timelineColor(log)}
                {...commonProps}
              />
            );
          })}
        </svg>
      </div>
      <div className="rounded-2xl border border-border/60 bg-white/75 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-sm font-semibold text-foreground">当前详情</div>
          <div className="text-xs text-muted-foreground">
            {selectedLog ? formatTime(selectedLog.timestamp) : "尚未选择扩散记录"}
          </div>
        </div>
        {selectedLogDetails}
      </div>
    </div>
  );
  const experimentsPanel = (
    <div className="space-y-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-foreground">扩散评估记录</div>
          <div className="text-xs text-muted-foreground">每次手动扩散都会记录参数、每跳命中与表达结果。</div>
        </div>
        <div className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700">
          {experimentLogs.length} 条
        </div>
      </div>
      {experimentLogs.length === 0 ? (
        <p className="text-sm text-muted-foreground">还没有手动实验记录。先在工具栏触发一次扩散。</p>
      ) : (
        <div className="space-y-3">
          {experimentLogs.map((entry) => (
            <button
              key={`${entry.timestamp}-${entry.manual_text ?? entry.trigger_type}`}
              type="button"
              onClick={() => {
                setSelectedLog(entry);
                startPlaybackFromEntry(entry);
                setActiveBottomTab("timeline");
              }}
              className="w-full rounded-2xl border border-border/70 bg-white/70 p-3 text-left transition hover:border-cyan-300 hover:bg-cyan-50/40"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold text-foreground">
                  {entry.manual_text?.trim() || entry.trigger_type}
                </div>
                <div className="text-xs text-muted-foreground">{formatTime(entry.timestamp)}</div>
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-600">
                <span className="rounded-full bg-slate-100 px-2 py-1">S {formatNumeric(entry.config_snapshot?.spreading_factor)}</span>
                <span className="rounded-full bg-slate-100 px-2 py-1">δ {formatNumeric(entry.config_snapshot?.retention_delta)}</span>
                <span className="rounded-full bg-slate-100 px-2 py-1">ρ {formatNumeric(entry.config_snapshot?.temporal_decay_rho)}</span>
                <span className="rounded-full bg-slate-100 px-2 py-1">T {formatNumeric(entry.config_snapshot?.diffusion_max_depth, 0)}</span>
                <span className="rounded-full bg-slate-100 px-2 py-1">Expr {formatNumeric(entry.config_snapshot?.expression_activation_threshold)}</span>
                <span className="rounded-full bg-slate-100 px-2 py-1">η {formatNumeric(entry.config_snapshot?.hebbian_learning_rate)}</span>
                <span className="rounded-full bg-slate-100 px-2 py-1">Decay {formatNumeric(entry.config_snapshot?.passive_decay_rate, 3)}</span>
                <span className="rounded-full bg-slate-100 px-2 py-1">RW {formatNumeric(entry.config_snapshot?.random_walk_probability)}</span>
              </div>
              <div className="mt-3 grid gap-2 text-xs text-slate-700 md:grid-cols-[1.2fr_1fr_1fr]">
                <div>
                  <div className="font-medium text-slate-900">Seeds</div>
                  <div>{entry.seeds.map((seed) => seed.label).join(" · ") || "无"}</div>
                </div>
                <div>
                  <div className="font-medium text-slate-900">结果</div>
                  <div>激活 {entry.activated_count ?? 0} 个 · 峰值 {formatNumeric(entry.activation_peak)}</div>
                  <div>泡 {entry.bubble_passed_filter ? "通过" : "未通过"} · 表达 {entry.expression_produced ? "有" : "无"}</div>
                </div>
                <div>
                  <div className="font-medium text-slate-900">Top</div>
                  <div>
                    {entry.top_activated
                      .slice(0, 3)
                      .map((node) => `${node.label} (${node.activation.toFixed(2)})`)
                      .join(" · ") || "无"}
                  </div>
                </div>
              </div>
              {entry.expression_text ? (
                <div className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                  表达：{entry.expression_text}
                </div>
              ) : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
  const drawerSections: Record<DrawerSectionId, React.ReactNode> = {
    graph_diagnostics: (
      <section className="space-y-3">
        <div>
          <div className="text-sm font-semibold text-foreground">图诊断</div>
          <div className="text-xs text-muted-foreground">边权重分布与最新图统计。</div>
        </div>
        <div className="rounded-2xl border border-border/60 bg-white/80 p-3">
          <svg width="100%" height="150" viewBox="0 0 520 150" preserveAspectRatio="none">
            {weightHistogram.map((bin) => {
              const barWidth = 520 / Math.max(1, weightHistogram.length);
              const height = (bin.count / maxHistogramCount) * 112;
              return (
                <g key={`drawer-hist-${bin.index}`}>
                  <rect
                    x={bin.index * barWidth + 3}
                    y={128 - height}
                    width={Math.max(8, barWidth - 6)}
                    height={Math.max(2, height)}
                    rx={4}
                    fill={bin.color}
                    opacity={0.92}
                  />
                  {bin.index < weightHistogram.length - 1 ? null : (
                    <text x={bin.index * barWidth + barWidth / 2} y={143} textAnchor="middle" fontSize="10" fill="#475569">
                      1.00
                    </text>
                  )}
                </g>
              );
            })}
            <line x1={0} x2={520} y1={128} y2={128} stroke="#CBD5E1" strokeWidth={1.5} />
            <text x={0} y={143} fontSize="10" fill="#475569">
              0.00
            </text>
            <text x={260} y={143} fontSize="10" fill="#475569" textAnchor="middle">
              权重 bins
            </text>
          </svg>
        </div>
        <div className="rounded-2xl border border-border/60 bg-white/80 p-3 text-sm">
          <div className="font-medium text-slate-900">统计</div>
          <div className="mt-2 space-y-1 text-slate-700">
            <div>mean: {formatNumeric(latestGraphLog?.graph_stats?.avg_weight ?? weightStats.mean)}</div>
            <div>median: {formatNumeric(latestGraphLog?.graph_stats?.median_weight ?? weightStats.median)}</div>
            <div>std: {formatNumeric(latestGraphLog?.graph_stats?.std_weight ?? weightStats.std)}</div>
            <div>min: {formatNumeric(latestGraphLog?.graph_stats?.min_weight ?? weightStats.min)}</div>
            <div>max: {formatNumeric(latestGraphLog?.graph_stats?.max_weight ?? weightStats.max)}</div>
          </div>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void loadSnapshot()}>
            刷新直方图
          </Button>
        </div>
      </section>
    ),
    cognition_state: (
      <section className="space-y-3">
        <div>
          <div className="text-sm font-semibold text-foreground">认知状态</div>
          <div className="text-xs text-muted-foreground">情绪、预测编码与注意力焦点。</div>
        </div>
        <div className="rounded-2xl border border-border/60 bg-white/80 p-3">
          <div className="text-sm font-medium text-slate-900">当前情绪</div>
          <div className="mt-2 grid gap-3 sm:grid-cols-[120px_1fr]">
            <div className="rounded-2xl border border-border/60 bg-slate-50/70 p-3">
              <svg width="100%" height="120" viewBox="0 0 160 120">
                <defs>
                  <radialGradient id="drawerRussellBg" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#e2e8f0" />
                    <stop offset="100%" stopColor="#f8fafc" />
                  </radialGradient>
                </defs>
                <circle cx="60" cy="60" r="45" fill="url(#drawerRussellBg)" stroke="#cbd5e1" strokeWidth="1.5" />
                <line x1="15" y1="60" x2="105" y2="60" stroke="#94a3b8" strokeDasharray="3 3" />
                <line x1="60" y1="15" x2="60" y2="105" stroke="#94a3b8" strokeDasharray="3 3" />
                <circle
                  cx={60 + clamp((emotionSnapshot?.valence ?? 0.1), -1, 1) * 40}
                  cy={60 - clamp(((emotionSnapshot?.arousal ?? 0.3) * 2) - 1, -1, 1) * 40}
                  r={5}
                  fill="#06b6d4"
                  stroke="#0f172a"
                  strokeWidth="1.2"
                />
              </svg>
            </div>
            <div className="space-y-1 text-sm text-slate-700">
              <div>V: {formatSigned(emotionSnapshot?.valence)}</div>
              <div>A: {formatNumeric(emotionSnapshot?.arousal)}</div>
              <div>来源: {emotionSnapshot?.source ?? "--"}</div>
              <div>更新时间: {emotionUpdatedAt ? formatTime(emotionUpdatedAt) : "--"}</div>
              {emotionSnapshot ? null : (
                <div className="text-xs text-muted-foreground">workspace.emotion 尚未完整暴露，当前为降级展示。</div>
              )}
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-border/60 bg-white/80 p-3 text-sm">
          <div className="font-medium text-slate-900">预测编码</div>
          <div className="mt-2 space-y-1 text-slate-700">
            {predictionSnapshot?.warming_up ? (
              <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
                预测编码预热中 ({predictionWarmupProgress ?? "--"})
              </div>
            ) : (
              <div className="rounded-xl border border-cyan-300 bg-cyan-50 px-3 py-2 text-cyan-900">
                预测编码已启用
              </div>
            )}
            <div>历史窗口: {predictionSnapshot?.history_window ?? "--"}</div>
            <div>本轮相似度: {formatNumeric(predictionSnapshot?.last_similarity)}</div>
            <div>惊喜节点: {surprisingNodeLabels.length > 0 ? surprisingNodeLabels.join(" · ") : "无"}</div>
            <div>熟悉节点: {familiarNodeLabels.length > 0 ? familiarNodeLabels.join(" · ") : "无"}</div>
          </div>
        </div>
        <div className="rounded-2xl border border-border/60 bg-white/80 p-3 text-sm">
          <div className="font-medium text-slate-900">注意力焦点</div>
          <div className="mt-2 space-y-1 text-slate-700">
            <div>max_focus_nodes: {attentionSnapshot?.max_focus_nodes ?? "--"}</div>
            <div>focus_seed_energy: {formatNumeric(attentionSnapshot?.focus_seed_energy)}</div>
            <div>
              焦点节点:
              {focusNodeIds.length > 0
                ? ` ${focusNodeIds
                  .slice(0, 5)
                  .map((nodeId) => resolveNodeLabel({ nodeId, labelById: nodeLabelById }))
                  .join(" · ")}`
                : " 无"}
            </div>
          </div>
        </div>
      </section>
    ),
    system_events: (
      <section className="space-y-3">
        <div>
          <div className="text-sm font-semibold text-foreground">系统事件</div>
          <div className="text-xs text-muted-foreground">广播历史与最近一次睡眠整合。</div>
        </div>
        <div className="rounded-2xl border border-border/60 bg-white/80 p-3 text-sm">
          <div className="font-medium text-slate-900">广播历史</div>
          <div className="mt-2 space-y-2">
            {effectiveBroadcastHistory.length > 0 ? (
              effectiveBroadcastHistory
                .slice()
                .reverse()
                .map((item) => (
                  <div key={item.broadcast_id} className="rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-medium text-slate-900">{item.bubble_summary || item.bubble_id}</div>
                      <div className="text-xs text-slate-600">{formatTime(item.timestamp)}</div>
                    </div>
                    <div className="mt-1 text-xs text-slate-700">
                      模块: {item.modules_updated.join(" · ") || "无"} {item.has_errors ? "· 有错误" : ""}
                      {item.overlap_warning ? " · overlap warning" : ""}
                    </div>
                  </div>
                ))
            ) : (
              <div className="text-xs text-muted-foreground">尚无广播事件。</div>
            )}
          </div>
        </div>
        {(configState?.consolidation.enabled ?? true) ? (
          <div className="rounded-2xl border border-border/60 bg-white/80 p-3 text-sm">
            <div className="font-medium text-slate-900">睡眠整合</div>
            <div className="mt-2 space-y-2 text-slate-700">
              {consolidationReport ? (
                <div className="rounded-xl border border-cyan-200 bg-cyan-50/70 px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-medium text-slate-900">
                      {consolidationReport.trigger} · {consolidationReport.interrupted ? "未完成" : "完成"}
                    </div>
                    <div className="text-xs text-slate-600">
                      {toEpochMs(consolidationReport.completed_at) ? formatTime(toEpochMs(consolidationReport.completed_at)!) : "--"}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-700">
                    <span>耗时 {consolidationReport.duration_ms} ms</span>
                    <span>回放 {consolidationReport.replay_report.replayedCount}</span>
                    <span>抽象节点 {consolidationReport.gist_report.abstractNodesCreated}</span>
                    <span>迁移冷区 {consolidationReport.archive_report.migratedCount}</span>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">尚无整合报告。</div>
              )}
              {consolidationHistory.length > 0 ? (
                <div className="space-y-2">
                  {consolidationHistory.slice(0, 3).map((item) => (
                    <div key={`${item.started_at}-${item.trigger}`} className="rounded-xl border border-border/60 bg-slate-50/80 px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-medium text-slate-900">{item.trigger}</div>
                        <div className="text-xs text-slate-600">
                          {toEpochMs(item.completed_at) ? formatTime(toEpochMs(item.completed_at)!) : "--"}
                        </div>
                      </div>
                      <div className="mt-1 text-xs text-slate-700">
                        回放 {item.replay_report.replayedCount} · 摘要 {item.gist_report.abstractNodesCreated} · 迁移 {item.archive_report.migratedCount}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="rounded-xl border border-border/60 bg-slate-50/80 px-3 py-2 text-xs">
                冷区月份：{archiveStats?.oldestMonth ?? "--"} → {archiveStats?.newestMonth ?? "--"}
              </div>
            </div>
          </div>
        ) : null}
      </section>
    )
  };

  return (
    <div className="relative flex flex-col gap-4 p-3">
      <Card className="shrink-0">
        <CardHeader className="pb-4">
          <CardTitle>认知总览</CardTitle>
          <CardDescription>先看运行状态，再进入传播图、日志和系统细节。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            {overviewItems.map((item) => (
              <div key={item.label} className="rounded-2xl border border-border/60 bg-white/75 px-4 py-3">
                <div className="text-xs text-muted-foreground">{item.label}</div>
                <div className="mt-1 text-lg font-semibold text-foreground">{item.value}</div>
                <div className="mt-1 text-xs text-slate-600">{item.detail}</div>
              </div>
            ))}
          </div>
          <div className={cn("status-surface rounded-2xl px-4 py-3 text-sm", alertBannerTone)}>
            {alertBannerText}
          </div>
        </CardContent>
      </Card>

      <div className="relative">
        <div
          className={cn(
            "space-y-4 transition-[margin-right] duration-200",
            isDetailsDrawerOpen ? "mr-[24rem]" : "mr-0"
          )}
        >
          <Card>
            <CardHeader className="pb-4">
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                  <div>
                    <CardTitle>传播工作区</CardTitle>
                    <CardDescription>图区域可拖拽放大缩小，日志和实验记录收敛到底部标签。</CardDescription>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" onClick={handleOpenParameterModal} disabled={!configState}>
                      {configState ? "调整参数" : "参数加载中…"}
                    </Button>
                    <Button variant="outline" onClick={() => setIsDetailsDrawerOpen((current) => !current)}>
                      {isDetailsDrawerOpen ? "隐藏状态详情" : "查看状态详情"}
                    </Button>
                    <Button variant="outline" onClick={() => setAutoRefresh((current) => !current)}>
                      自动刷新 {autoRefresh ? "开启" : "关闭"}
                    </Button>
                  </div>
                </div>
                <div className="flex flex-col gap-2 xl:flex-row xl:items-center">
                  <Input
                    value={manualText}
                    onChange={(event) => setManualText(event.target.value)}
                    placeholder="输入触发文本"
                    className="xl:max-w-md"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button onClick={handleManualSpread} disabled={manualStatus === "pending"}>
                      {manualStatus === "pending" ? "触发中…" : "手动触发扩散"}
                    </Button>
                    {(configState?.consolidation.enabled ?? true) ? (
                      <Button variant="outline" onClick={handleManualConsolidation} disabled={consolidationStatus === "pending"}>
                        {consolidationStatus === "pending" ? "整合中…" : "手动触发整合"}
                      </Button>
                    ) : null}
                  </div>
                </div>
                {manualStatus !== "idle" || consolidationStatus !== "idle" ? (
                  <div className="flex flex-wrap gap-3 text-xs">
                    {manualStatus === "success" ? <span className="text-emerald-700">手动触发完成</span> : null}
                    {manualStatus === "error" ? <span className="text-rose-700">手动触发失败</span> : null}
                    {consolidationStatus === "success" ? <span className="text-emerald-700">整合完成</span> : null}
                    {consolidationStatus === "error" ? <span className="text-rose-700">整合失败</span> : null}
                  </div>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-4">
                <div
                  className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-slate-100 to-white p-4 shadow-lg"
                >
                  <div className="absolute right-4 top-4 z-10 flex items-center gap-2 rounded-full bg-slate-950/70 px-3 py-1.5 text-xs text-cyan-50 shadow">
                    <span>{Math.round(graphViewport.scale * 100)}%</span>
                    <span className="text-cyan-100/70">滚轮缩放 · 拖拽平移</span>
                    <button
                      type="button"
                      onClick={handleResetGraphViewport}
                      className="rounded-full border border-cyan-100/25 px-2 py-0.5 text-[11px] transition hover:bg-cyan-100/10"
                    >
                      重置
                    </button>
                  </div>
                  {activeRoundLabel ? (
                    <div className="absolute bottom-4 left-4 z-10 rounded-full bg-slate-950/85 px-3 py-1 text-xs font-medium text-cyan-100 shadow">
                      {activeRoundLabel}
                    </div>
                  ) : null}
                  <div
                    className="relative h-[24rem] overflow-hidden rounded-2xl bg-slate-900 md:h-[30rem] xl:h-[36rem]"
                    ref={containerRef}
                  >
                    <canvas
                      ref={canvasRef}
                      className={cn(
                        "block h-full w-full bg-transparent",
                        isGraphPanning ? "cursor-grabbing" : "cursor-grab"
                      )}
                      width={size.width}
                      height={size.height}
                      onMouseDown={handleCanvasMouseDown}
                      onMouseMove={handleMouseMove}
                      onWheel={handleCanvasWheel}
                      onMouseLeave={() => {
                        setHoveredNode(null);
                        setTooltipPosition(null);
                      }}
                    />
                    {hoveredNode && tooltipPosition ? (
                      <div
                        className="pointer-events-none absolute z-20 max-w-xs rounded-lg bg-slate-900/90 px-3 py-2 text-xs text-white"
                        style={{ left: tooltipPosition.x + 12, top: tooltipPosition.y + 12 }}
                      >
                        <div className="font-semibold">{hoveredNode.content}</div>
                        <div>类型：{hoveredNode.type}</div>
                        <div>激活：{hoveredNode.activation_level.toFixed(3)}</div>
                        <div>基础 B：{hoveredNode.base_level_activation.toFixed(3)}</div>
                        <div>激活历史：{hoveredNode.activation_history.length}</div>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="overflow-hidden rounded-3xl border border-border/60 bg-white/55">
                  <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {bottomTabMeta.map((tab) => (
                        <button
                          key={tab.id}
                          type="button"
                          onClick={() => setActiveBottomTab(tab.id)}
                          className={cn(
                            "rounded-full border px-3 py-1.5 text-sm transition",
                            activeBottomTab === tab.id
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border/70 bg-white/75 text-foreground hover:bg-secondary/60"
                          )}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {bottomTabMeta.find((tab) => tab.id === activeBottomTab)?.helper}
                    </div>
                  </div>
                  <div className="p-4">
                    {activeBottomTab === "timeline" ? timelinePanel : experimentsPanel}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {isDetailsDrawerOpen ? (
          <aside className="absolute inset-y-0 right-0 z-30 w-[24rem]">
            <div className="glass-panel flex h-full flex-col overflow-hidden">
              <div className="flex items-start justify-between gap-3 border-b border-border/60 px-5 py-4">
                <div>
                  <div className="font-display text-lg font-semibold tracking-wide text-foreground">状态详情</div>
                  <div className="text-sm text-muted-foreground">主页面只保留总览，详细诊断集中到这里。</div>
                </div>
                <Button variant="outline" size="sm" onClick={() => setIsDetailsDrawerOpen(false)}>
                  关闭
                </Button>
              </div>
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
                {drawerSections.graph_diagnostics}
                {drawerSections.cognition_state}
                {drawerSections.system_events}
              </div>
            </div>
          </aside>
        ) : null}
      </div>

      {isParameterModalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4"
          onMouseDown={(event) => {
            if (event.target !== event.currentTarget) {
              return;
            }

            if (hasDraftChanges || parameterApplyStatus === "pending") {
              return;
            }

            handleCancelParameterModal();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="cognition-parameter-dialog-title"
            className="glass-panel flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden"
          >
            <div className="border-b border-border/60 px-6 py-5">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1">
                  <h3 id="cognition-parameter-dialog-title" className="font-display text-xl font-semibold tracking-wide text-foreground">
                    调整参数
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    所有改动先保存在弹层草稿中，点击“应用”后再一次性提交。
                  </p>
                </div>
                <div className="rounded-full border border-border/60 bg-white/70 px-3 py-1 text-xs text-slate-700">
                  {hasDraftChanges ? "有未应用修改" : "当前配置未改动"}
                </div>
              </div>
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto px-6 py-5">
              {parameterGroups.map((group) => {
                const isExpanded = expandedParameterGroup === group.id;
                const groupSummary = groupSummaryText(group.id, parameterModalConfig);
                return (
                  <section key={group.id} className="overflow-hidden rounded-2xl border border-border/60 bg-white/70">
                    <button
                      type="button"
                      className="flex w-full flex-col gap-3 px-4 py-4 text-left transition hover:bg-slate-50/80"
                      aria-expanded={isExpanded}
                      onClick={() => {
                        setExpandedParameterGroup((current) => (current === group.id ? null : group.id));
                      }}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="space-y-1">
                          <div className="text-sm font-semibold text-foreground">{group.title}</div>
                          <div className="text-xs text-muted-foreground">{group.description}</div>
                        </div>
                        <div className="rounded-full border border-border/60 bg-white/80 px-2.5 py-1 text-xs text-slate-700">
                          {isExpanded ? "收起" : "展开"}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {groupSummary.map((item) => (
                          <span key={`${group.id}-${item}`} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700">
                            {item}
                          </span>
                        ))}
                      </div>
                    </button>

                    {isExpanded ? (
                      <div className="border-t border-border/60 bg-slate-50/60 px-4 py-4">
                        {group.id === "quick_toggles" ? (
                          <div className="space-y-3">
                            {toggleDefinitions.map((toggle) => (
                              <label
                                key={toggle.id}
                                className="flex items-start gap-3 rounded-2xl border border-border/60 bg-white/85 px-4 py-3 text-sm"
                              >
                                <input
                                  type="checkbox"
                                  checked={toggle.state(parameterModalConfig)}
                                  onChange={(event) => handleDraftToggle(toggle.update, event.target.checked)}
                                  className="mt-1"
                                />
                                <span className="space-y-1">
                                  <span className="block font-medium text-foreground">{toggle.compactLabel}</span>
                                  <span className="block text-xs text-slate-600">{toggle.description}</span>
                                  <span className="block text-[11px] text-muted-foreground">{toggle.referenceText}</span>
                                </span>
                              </label>
                            ))}
                          </div>
                        ) : (
                          <div className="space-y-3">
                            {sliderDefinitions
                              .filter((slider) => slider.group === group.id)
                              .map((slider) => {
                                const value = slider.state(parameterModalConfig);
                                return (
                                  <div key={slider.id} className="rounded-2xl border border-border/60 bg-white/85 px-4 py-3">
                                    <div className="flex items-start justify-between gap-4">
                                      <div className="space-y-1">
                                        <div className="text-sm font-medium text-foreground">{slider.compactLabel}</div>
                                        <div className="text-xs text-slate-600">{slider.description}</div>
                                      </div>
                                      <div className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-800">
                                        {slider.summaryFormatter(value)}
                                      </div>
                                    </div>
                                    <input
                                      type="range"
                                      min={slider.min}
                                      max={slider.max}
                                      step={slider.step}
                                      value={value}
                                      onChange={(event) => handleDraftSlider(slider.update, Number(event.target.value))}
                                      className="mt-3 w-full"
                                    />
                                    <div className="mt-2 text-[11px] text-muted-foreground">{slider.referenceText}</div>
                                  </div>
                                );
                              })}
                          </div>
                        )}
                      </div>
                    ) : null}
                  </section>
                );
              })}

              {hasDraftChanges ? (
                <div className="rounded-2xl border border-amber-300 bg-amber-50/80 px-4 py-3 text-xs text-amber-950">
                  当前有未应用修改。为避免误关，按 `Esc` 或点击遮罩不会关闭弹层。
                </div>
              ) : null}
              {parameterApplyError ? (
                <div className="rounded-2xl border border-rose-300 bg-rose-50/80 px-4 py-3 text-sm text-rose-900">
                  {parameterApplyError}
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-3 border-t border-border/60 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs text-muted-foreground">
                {hasDraftChanges ? "准备应用新的参数草稿。" : "还没有新的草稿修改。"}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={handleCancelParameterModal} disabled={parameterApplyStatus === "pending"}>
                  取消
                </Button>
                <Button onClick={handleApplyParameterDraft} disabled={!hasDraftChanges || parameterApplyStatus === "pending"}>
                  {parameterApplyStatus === "pending" ? "应用中…" : "应用"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default CognitionDebugPage;
