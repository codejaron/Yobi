import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import {
  DEFAULT_COGNITION_CONFIG,
  type ActivationLogEntry,
  type ActivationPathLogRound,
  type CognitionConfig,
  type CognitionConfigPatch,
  type CognitionDebugSnapshot,
  type MemoryEdge,
  type MemoryNode
} from "@shared/cognition";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@renderer/components/ui/card";

const NODE_COLORS: Record<MemoryNode["type"], string> = {
  fact: "#4A90D9",
  event: "#7EC680",
  concept: "#F5A623",
  emotion_anchor: "#D0021B",
  external_entity: "#9013FE",
  time_marker: "#9B9B9B",
  intent: "#50E3C2",
  pattern: "#8B572A"
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
  activeRound: ActivationPathLogRound | null;
  activatedNodes: Set<string>;
  progress: number;
}) {
  const { context, snapshot, positions, width, height, activeRound, activatedNodes, progress } = input;

  context.clearRect(0, 0, width, height);
  if (!snapshot) {
    return;
  }

  const activeEdgeKeys = new Set(activeRound?.propagated.map((entry) => `${entry.from}->${entry.to}`) ?? []);
  const frontierNodes = new Set(activeRound?.frontier.map((entry) => entry.node_id) ?? []);
  const targetNodes = new Set(activeRound?.propagated.map((entry) => entry.to) ?? []);

  context.lineCap = "round";

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
}

const sliderDefinitions = [
  {
    id: "spreading_factor",
    label: "扩散因子 S — SYNAPSE §3.2",
    description: "控制传播强度",
    min: 0.1,
    max: 1,
    step: 0.05,
    state: (cfg: CognitionConfig) => cfg.spreading.spreading_factor,
    update: (value: number) => ({ spreading: { spreading_factor: value } })
  },
  {
    id: "retention_delta",
    label: "自身保留率 δ — SYNAPSE §4.1",
    description: "激活每轮保留比例",
    min: 0.1,
    max: 0.9,
    step: 0.05,
    state: (cfg: CognitionConfig) => cfg.spreading.retention_delta,
    update: (value: number) => ({ spreading: { retention_delta: value } })
  },
  {
    id: "diffusion_max_depth",
    label: "最大扩散轮数 T — SYNAPSE §3.2",
    description: "节点拓扑传播深度",
    min: 1,
    max: 5,
    step: 1,
    state: (cfg: CognitionConfig) => cfg.spreading.diffusion_max_depth,
    update: (value: number) => ({ spreading: { diffusion_max_depth: value } })
  },
  {
    id: "sigmoid_theta",
    label: "Sigmoid 阈值 θ — SYNAPSE §3.2（第二阶段生效）",
    description: "预留 Sigmoid 控制",
    min: 0.05,
    max: 0.8,
    step: 0.05,
    state: (cfg: CognitionConfig) => cfg.sigmoid.theta,
    update: (value: number) => ({ sigmoid: { theta: value } })
  },
  {
    id: "lateral_inhibition_beta",
    label: "抑制强度 β — SYNAPSE §3.2（第二阶段生效）",
    description: "预留侧向抑制",
    min: 0,
    max: 0.5,
    step: 0.05,
    state: (cfg: CognitionConfig) => cfg.inhibition.lateral_inhibition_beta,
    update: (value: number) => ({ inhibition: { lateral_inhibition_beta: value } })
  },
  {
    id: "expression_activation_threshold",
    label: "表达激活阈值",
    description: "泡成为表达候选所需激活",
    min: 0.1,
    max: 0.9,
    step: 0.05,
    state: (cfg: CognitionConfig) => cfg.expression.activation_threshold,
    update: (value: number) => ({ expression: { activation_threshold: value } })
  },
  {
    id: "expression_cooldown_minutes",
    label: "表达冷却时间（分钟）",
    description: "控制表达频率",
    min: 5,
    max: 120,
    step: 5,
    state: (cfg: CognitionConfig) => cfg.expression.cooldown_minutes,
    update: (value: number) => ({ expression: { cooldown_minutes: value } })
  },
  {
    id: "heartbeat_lambda_minutes",
    label: "心跳均值（分钟）",
    description: "子意识循环的平均周期",
    min: 5,
    max: 60,
    step: 1,
    state: (cfg: CognitionConfig) => cfg.loop.heartbeat_lambda_minutes,
    update: (value: number) => ({ loop: { heartbeat_lambda_minutes: value } })
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

export function CognitionDebugPage() {
  const [snapshot, setSnapshot] = useState<CognitionDebugSnapshot | null>(null);
  const [configState, setConfigState] = useState<CognitionConfig | null>(null);
  const [manualText, setManualText] = useState("中午吃什么");
  const [manualStatus, setManualStatus] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [hoveredNode, setHoveredNode] = useState<MemoryNode | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ x: number; y: number } | null>(null);
  const [selectedLog, setSelectedLog] = useState<ActivationLogEntry | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const nodePositionsRef = useRef<Record<string, { x: number; y: number }>>({});
  const playbackTimeoutRef = useRef<number | null>(null);
  const [playbackSession, setPlaybackSession] = useState<PlaybackSession | null>(null);
  const [playbackFrame, setPlaybackFrame] = useState<PlaybackFrame | null>(null);
  const [expandedLogDetails, setExpandedLogDetails] = useState<Record<string, boolean>>({});

  const loadSnapshot = useCallback(async () => {
    try {
      const next = await window.companion.getCognitionDebugSnapshot();
      setSnapshot(next);
      setConfigState(next.config);
    } catch (error) {
      // console.error(error);
    }
  }, []);

  useEffect(() => {
    loadSnapshot();
  }, [loadSnapshot]);

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
      void loadSnapshot();
    });
    return () => unsubscribe();
  }, [autoRefresh, loadSnapshot, startPlaybackFromEntry]);

  useEffect(() => {
    if (!snapshot || !canvasRef.current || size.width === 0 || size.height === 0) {
      return;
    }

    const nodes: GraphNode[] = snapshot.graph.nodes.map((node) => ({ ...node }));
    const links: GraphLink[] = snapshot.graph.edges.map((edge) => ({ ...edge }));
    const previousPositions = nodePositionsRef.current;
    const centerX = size.width / 2;
    const centerY = size.height / 2;
    const baseRadius = Math.max(90, Math.min(size.width, size.height) * 0.28);

    nodes.forEach((node, index) => {
      const previous = previousPositions[node.id];
      if (previous) {
        node.x = previous.x;
        node.y = previous.y;
        return;
      }

      const angle = (Math.PI * 2 * index) / Math.max(1, nodes.length);
      const radius = baseRadius + (index % 3) * 18;
      node.x = centerX + Math.cos(angle) * radius;
      node.y = centerY + Math.sin(angle) * radius;
    });

    const simulation = d3
      .forceSimulation(nodes)
      .force(
        "link",
        d3
          .forceLink(links)
          .id((datum: GraphNode) => datum.id)
          .distance((link: GraphLink) => 100 - Math.min(70, link.weight * 60))
          .strength((link: GraphLink) => 0.1 + link.weight * 0.4)
      )
      .force("charge", d3.forceManyBody().strength(-120))
      .force("collision", d3.forceCollide().radius((node: GraphNode) => 24 + node.activation_level * 24))
      .force("center", d3.forceCenter(centerX, centerY))
      .stop();

    for (let index = 0; index < 140; index += 1) {
      simulation.tick();
    }
    simulation.stop();

    const positions: Record<string, { x: number; y: number }> = {};
    nodes.forEach((node) => {
      positions[node.id] = {
        x: clamp(node.x ?? centerX, 48, Math.max(48, size.width - 48)),
        y: clamp(node.y ?? centerY, 48, Math.max(48, size.height - 48))
      };
    });
    nodePositionsRef.current = positions;
  }, [snapshot, size]);

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
      activeRound,
      activatedNodes,
      progress: playbackFrame?.progress ?? 0
    });
  }, [playbackFrame, playbackSession, size, snapshot]);

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
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    let closest: MemoryNode | null = null;
    let minDistance = Infinity;
    const nodes = snapshot?.graph.nodes ?? [];
    nodes.forEach((node) => {
      const pos = nodePositionsRef.current[node.id];
      if (!pos) {
        return;
      }
      const distance = Math.hypot(pos.x - x, pos.y - y);
      if (distance < minDistance && distance < 40) {
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
      setSelectedLog(result.entry);
      startPlaybackFromEntry(result.entry);
    } catch (error) {
      setManualStatus("error");
    }
  };

  const mergeConfig = (base: CognitionConfig, partial: CognitionConfigPatch): CognitionConfig => {
    return {
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
        ...(partial.loop ?? {})
      }
    };
  };

  const handleSlider = async (update: (value: number) => CognitionConfigPatch, value: number) => {
    if (!configState) {
      return;
    }
    const partial = update(value);
    setConfigState((current) => (current ? mergeConfig(current, partial) : current));
    try {
      await window.companion.updateCognitionConfig(partial);
      await loadSnapshot();
    } catch {
      // ignore
    }
  };

  const topNodes = useMemo(() => {
    if (!snapshot) {
      return [];
    }
    return [...snapshot.graph.nodes]
      .sort((a, b) => b.activation_level - a.activation_level)
      .slice(0, 3);
  }, [snapshot]);

  const logDots = useMemo(() => snapshot?.lastLogs ?? [], [snapshot]);

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

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-3">
      <div className="grid flex-1 gap-4 lg:grid-cols-[3fr_2fr]">
        <div className="relative flex flex-col rounded-3xl bg-gradient-to-br from-slate-100 to-white p-4 shadow-lg" ref={containerRef}>
          <div className="absolute right-4 top-4 grid gap-1 rounded-2xl bg-white/80 px-4 py-2 text-xs shadow">
            <div className="text-muted-foreground">总节点 / 边数</div>
            <div className="text-base font-semibold text-foreground">
              {stats.node_count ?? 0} nodes · {stats.edge_count ?? 0} edges
            </div>
            <div className="text-muted-foreground">平均激活 {(stats.avg_activation ?? 0).toFixed(2)}</div>
            {topNodes.map((node) => (
              <div key={node.id} className="text-xs text-foreground">
                {node.content.slice(0, 24)} · {node.activation_level.toFixed(2)}
              </div>
            ))}
          </div>
          {activeRoundLabel ? (
            <div className="absolute bottom-4 left-4 rounded-full bg-slate-950/85 px-3 py-1 text-xs font-medium text-cyan-100 shadow">
              {activeRoundLabel}
            </div>
          ) : null}
          <canvas
            ref={canvasRef}
            className="h-full w-full rounded-2xl bg-slate-900"
            width={size.width}
            height={size.height}
            onMouseMove={handleMouseMove}
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

        <div className="flex flex-col gap-4">
          <Card className="min-h-[260px]">
            <CardHeader>
              <CardTitle>心跳日志</CardTitle>
              <CardDescription>每条日志对应一次扩散，点击圆点可回放传导路径</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
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
                      : ((time - timelineBounds.min) / Math.max(1, timelineBounds.max - timelineBounds.min)) *
                        timelineWidth;
                  return (
                    <circle
                      key={`${log.timestamp}-${index}`}
                      cx={x}
                      cy={timelineHeight / 2}
                      r={6}
                      fill={timelineColor(log)}
                      onMouseEnter={() => setSelectedLog(log)}
                      onMouseLeave={() => setSelectedLog(null)}
                      onClick={() => {
                        setSelectedLog(log);
                        startPlaybackFromEntry(log);
                      }}
                      style={{ cursor: "pointer" }}
                    />
                  );
                })}
              </svg>
              {selectedLog ? (
                <div className="space-y-1 rounded-lg border border-border/60 bg-white/80 p-2 text-xs">
                  <div>时间：{formatTime(selectedLog.timestamp)}</div>
                  <div>触发：{selectedLog.trigger_type}</div>
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
                  {selectedLog.evaluation_score != null ? (
                    <div>评分：{selectedLog.evaluation_score.toFixed(2)}</div>
                  ) : null}
                  {(selectedLog.path_log ?? []).length > 0 ? (
                    <details className="mt-2 rounded-md border border-border/60 bg-white/70 px-2 py-1">
                      <summary className="cursor-pointer select-none font-medium text-slate-900">
                        三阶段详情（每轮 Top）
                      </summary>
                      <div className="mt-2 space-y-2">
                        {buildRoundStageRows({
                          pathLog: selectedLog.path_log,
                          labelById: nodeLabelById
                        }).map((round) => (
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
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">悬浮看详情，点击圆点回放某一轮扩散</p>
              )}
            </CardContent>
          </Card>

          <Card className="flex flex-col gap-3">
            <CardHeader>
              <CardTitle>参数控制</CardTitle>
              <CardDescription>调整扩散、表达与心跳</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {sliderDefinitions.map((slider) => {
                const value = configState ? slider.state(configState) : slider.state(DEFAULT_COGNITION_CONFIG);
                return (
                  <div key={slider.id} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span>{slider.label}</span>
                      <span className="font-semibold">{value.toFixed(2)}</span>
                    </div>
                    <input
                      type="range"
                      min={slider.min}
                      max={slider.max}
                      step={slider.step}
                      value={value}
                      onChange={(event) => handleSlider(slider.update, Number(event.target.value))}
                      className="w-full"
                    />
                    <div className="text-muted-foreground text-xs">{slider.description}</div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <Card className="space-y-3">
            <CardHeader>
              <CardTitle>手动触发</CardTitle>
              <CardDescription>输入文字，实时观察扩散</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input
                value={manualText}
                onChange={(event) => setManualText(event.target.value)}
                placeholder="输入触发文本"
              />
              <div className="flex items-center gap-2">
                <Button onClick={handleManualSpread} disabled={manualStatus === "pending"}>
                  {manualStatus === "pending" ? "触发中…" : "手动触发扩散"}
                </Button>
                <Button variant="outline" onClick={() => setAutoRefresh((current) => !current)}>
                  自动刷新 {autoRefresh ? "开启" : "关闭"}
                </Button>
              </div>
              {manualStatus === "success" ? <p className="text-xs text-emerald-700">触发完成</p> : null}
              {manualStatus === "error" ? <p className="text-xs text-rose-700">触发失败</p> : null}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="min-h-0">
        <CardHeader>
          <CardTitle>扩散评估记录</CardTitle>
          <CardDescription>每次手动扩散自动记录输入、参数、每跳命中和表达结果，用来比较参数是否合理。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {experimentLogs.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有手动实验记录。先在右下触发一次扩散。</p>
          ) : (
            <div className="max-h-[320px] space-y-3 overflow-y-auto pr-1">
              {experimentLogs.map((entry) => (
                <button
                  key={`${entry.timestamp}-${entry.manual_text ?? entry.trigger_type}`}
                  type="button"
                  onClick={() => {
                    setSelectedLog(entry);
                    startPlaybackFromEntry(entry);
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
                    <span className="rounded-full bg-slate-100 px-2 py-1">
                      S {formatNumeric(entry.config_snapshot?.spreading_factor)}
                    </span>
                    <span className="rounded-full bg-slate-100 px-2 py-1">
                      δ {formatNumeric(entry.config_snapshot?.retention_delta)}
                    </span>
                    <span className="rounded-full bg-slate-100 px-2 py-1">
                      ρ {formatNumeric(entry.config_snapshot?.temporal_decay_rho)}
                    </span>
                    <span className="rounded-full bg-slate-100 px-2 py-1">
                      T {formatNumeric(entry.config_snapshot?.diffusion_max_depth, 0)}
                    </span>
                    <span className="rounded-full bg-slate-100 px-2 py-1">
                      Expr {formatNumeric(entry.config_snapshot?.expression_activation_threshold)}
                    </span>
                  </div>

                  <div className="mt-3 grid gap-2 text-xs text-slate-700 md:grid-cols-[1.2fr_1fr_1fr]">
                    <div>
                      <div className="font-medium text-slate-900">Seeds</div>
                      <div>{entry.seeds.map((seed) => seed.label).join(" · ") || "无"}</div>
                    </div>
                    <div>
                      <div className="font-medium text-slate-900">结果</div>
                      <div>
                        激活 {entry.activated_count ?? 0} 个 · 峰值 {formatNumeric(entry.activation_peak)}
                      </div>
                      <div>
                        泡 {entry.bubble_passed_filter ? "通过" : "未通过"} · 表达 {entry.expression_produced ? "有" : "无"}
                      </div>
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

                  <div className="mt-3 space-y-1 text-xs text-slate-700">
                    {(entry.hop_summaries ?? []).length > 0 ? (
                      (entry.hop_summaries ?? []).map((hop) => (
                        <div key={`${entry.timestamp}-hop-${hop.depth}`}>
                          <span className="font-medium text-slate-900">Hop {hop.depth}</span>
                          <span className="ml-2">
                            {hop.nodes.map((node) => `${node.label} (${node.activation.toFixed(2)})`).join(" · ") || "无传播"}
                          </span>
                        </div>
                      ))
                    ) : (
                      <div>
                        <span className="font-medium text-slate-900">Hop</span>
                        <span className="ml-2">无传播</span>
                      </div>
                    )}
                  </div>
                  {(entry.path_log ?? []).length > 0 ? (
                    <div className="mt-3 rounded-xl border border-border/60 bg-slate-50/70 px-3 py-2 text-xs text-slate-700">
                      <div
                        className="flex w-full items-center justify-between text-left font-medium text-slate-900"
                        onClick={(event) => {
                          event.stopPropagation();
                          const key = `${entry.timestamp}-${entry.manual_text ?? entry.trigger_type}`;
                          setExpandedLogDetails((current) => ({ ...current, [key]: !current[key] }));
                        }}
                      >
                        <span>三阶段详情（每轮 Top）</span>
                        <span>
                          {expandedLogDetails[`${entry.timestamp}-${entry.manual_text ?? entry.trigger_type}`] ? "收起" : "展开"}
                        </span>
                      </div>
                      {expandedLogDetails[`${entry.timestamp}-${entry.manual_text ?? entry.trigger_type}`] ? (
                        <div className="mt-2 space-y-2">
                          {buildRoundStageRows({
                            pathLog: entry.path_log,
                            labelById: nodeLabelById
                          }).map((round) => (
                            <div key={`experiment-round-${entry.timestamp}-${round.depth}`} className="rounded-lg border border-border/50 bg-white/90 p-2">
                              <div className="font-medium text-slate-900">Round {round.depth}</div>
                              <div className="mt-1">Propagation: {round.propagation}</div>
                              <div>Inhibition: {round.inhibition}</div>
                              <div>Sigmoid: {round.sigmoid}</div>
                              {round.trimmed ? <div>Trimmed: {round.trimmed}</div> : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {entry.expression_text ? (
                    <div className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                      表达：{entry.expression_text}
                    </div>
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default CognitionDebugPage;
