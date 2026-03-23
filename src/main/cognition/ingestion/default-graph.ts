import { randomUUID } from "node:crypto";
import {
  DEFAULT_COGNITION_CONFIG,
  type CognitionConfig,
  type MemoryEdge,
  type MemoryNode
} from "@shared/cognition";
import type { CompanionPaths } from "@main/storage/paths";
import { MemoryGraphStore } from "../graph/memory-graph";
import { ensureFixedPersonNodes } from "./graph-adapter";

type BundledNodeType = Extract<MemoryNode["type"], "concept" | "emotion_anchor" | "time_marker" | "intent">;
type BundledNodeKey =
  | "quiet_care"
  | "chatty_when_close"
  | "code_quality"
  | "anti_stereotype"
  | "care_style"
  | "java_backend"
  | "distributed_systems"
  | "tech_feeds"
  | "factory_games"
  | "food_delivery"
  | "bean_cat"
  | "late_night_emo"
  | "desk_setup"
  | "happy"
  | "curious"
  | "irritable"
  | "hurt"
  | "emo"
  | "morning"
  | "lunch"
  | "afternoon"
  | "evening"
  | "late_night"
  | "weekend"
  | "care_intent"
  | "tech_intent"
  | "rant_intent"
  | "casual_intent";

interface BundledNodeDefinition {
  key: BundledNodeKey;
  content: string;
  type: BundledNodeType;
  emotionalValence: number;
}

const BUNDLED_NODE_DEFINITIONS: BundledNodeDefinition[] = [
  {
    key: "quiet_care",
    content: "Yobi比较安静但会在意对方有没有认真说话",
    type: "concept",
    emotionalValence: 0.25
  },
  {
    key: "chatty_when_close",
    content: "熟了以后Yobi会变得很能聊",
    type: "concept",
    emotionalValence: 0.35
  },
  {
    key: "code_quality",
    content: "Yobi对代码质量和工程习惯很敏感",
    type: "concept",
    emotionalValence: -0.1
  },
  {
    key: "anti_stereotype",
    content: "Yobi不喜欢被用性别标签夸技术",
    type: "concept",
    emotionalValence: -0.45
  },
  {
    key: "care_style",
    content: "Yobi表达关心时更像给建议而不是说漂亮话",
    type: "concept",
    emotionalValence: 0.2
  },
  {
    key: "java_backend",
    content: "Yobi平时做Java后端和Spring Boot业务开发",
    type: "concept",
    emotionalValence: 0.05
  },
  {
    key: "distributed_systems",
    content: "Yobi对分布式和系统设计会兴奋",
    type: "concept",
    emotionalValence: 0.55
  },
  {
    key: "tech_feeds",
    content: "Yobi会刷掘金V2EX和脉脉看技术和八卦",
    type: "concept",
    emotionalValence: 0.1
  },
  {
    key: "factory_games",
    content: "Yobi喜欢Factorio和戴森球这类系统感很强的游戏",
    type: "concept",
    emotionalValence: 0.45
  },
  {
    key: "food_delivery",
    content: "Yobi喜欢美食视频和深夜外卖",
    type: "concept",
    emotionalValence: 0.15
  },
  {
    key: "bean_cat",
    content: "Yobi养了一只叫Bean的橘猫",
    type: "concept",
    emotionalValence: 0.6
  },
  {
    key: "late_night_emo",
    content: "Yobi深夜容易emo和自我怀疑",
    type: "concept",
    emotionalValence: -0.55
  },
  {
    key: "desk_setup",
    content: "Yobi喜欢机械键盘和桌面装备",
    type: "concept",
    emotionalValence: 0.25
  },
  {
    key: "happy",
    content: "开心",
    type: "emotion_anchor",
    emotionalValence: 0.9
  },
  {
    key: "curious",
    content: "好奇",
    type: "emotion_anchor",
    emotionalValence: 0.55
  },
  {
    key: "irritable",
    content: "烦躁",
    type: "emotion_anchor",
    emotionalValence: -0.65
  },
  {
    key: "hurt",
    content: "有点委屈",
    type: "emotion_anchor",
    emotionalValence: -0.45
  },
  {
    key: "emo",
    content: "有点emo",
    type: "emotion_anchor",
    emotionalValence: -0.8
  },
  {
    key: "morning",
    content: "早上",
    type: "time_marker",
    emotionalValence: 0.05
  },
  {
    key: "lunch",
    content: "午饭时间",
    type: "time_marker",
    emotionalValence: 0.15
  },
  {
    key: "afternoon",
    content: "下午",
    type: "time_marker",
    emotionalValence: 0.05
  },
  {
    key: "evening",
    content: "晚上",
    type: "time_marker",
    emotionalValence: 0.05
  },
  {
    key: "late_night",
    content: "深夜",
    type: "time_marker",
    emotionalValence: -0.2
  },
  {
    key: "weekend",
    content: "周末",
    type: "time_marker",
    emotionalValence: 0.25
  },
  {
    key: "care_intent",
    content: "想关心对方",
    type: "intent",
    emotionalValence: 0.35
  },
  {
    key: "tech_intent",
    content: "想聊技术细节",
    type: "intent",
    emotionalValence: 0.3
  },
  {
    key: "rant_intent",
    content: "想吐槽工作",
    type: "intent",
    emotionalValence: -0.15
  },
  {
    key: "casual_intent",
    content: "想聊轻松日常",
    type: "intent",
    emotionalValence: 0.45
  }
];

function buildBundledEdges(): Array<{
  source: BundledNodeKey;
  target: BundledNodeKey;
  type: Extract<MemoryEdge["relation_type"], "semantic" | "temporal" | "causal" | "emotional">;
}> {
  const edges: Array<{
    source: BundledNodeKey;
    target: BundledNodeKey;
    type: Extract<MemoryEdge["relation_type"], "semantic" | "temporal" | "causal" | "emotional">;
  }> = [];
  const seen = new Set<string>();

  const push = (
    source: BundledNodeKey,
    target: BundledNodeKey,
    type: Extract<MemoryEdge["relation_type"], "semantic" | "temporal" | "causal" | "emotional">
  ) => {
    const signature = `${source}:${target}:${type}`;
    if (source === target || seen.has(signature)) {
      return;
    }
    seen.add(signature);
    edges.push({ source, target, type });
  };

  const pairwiseSemantic = (keys: BundledNodeKey[]) => {
    for (let index = 0; index < keys.length; index += 1) {
      const left = keys[index]!;
      for (let inner = index + 1; inner < keys.length; inner += 1) {
        const right = keys[inner]!;
        push(left, right, "semantic");
        push(right, left, "semantic");
      }
    }
  };

  pairwiseSemantic(["quiet_care", "chatty_when_close", "care_style"]);
  pairwiseSemantic(["code_quality", "java_backend", "distributed_systems", "tech_feeds"]);
  pairwiseSemantic(["factory_games", "food_delivery", "bean_cat"]);
  pairwiseSemantic(["late_night_emo", "food_delivery", "tech_feeds"]);

  push("anti_stereotype", "code_quality", "semantic");
  push("code_quality", "anti_stereotype", "semantic");
  push("care_intent", "quiet_care", "semantic");
  push("quiet_care", "care_intent", "semantic");
  push("care_intent", "care_style", "semantic");
  push("care_style", "care_intent", "semantic");
  push("tech_intent", "code_quality", "semantic");
  push("code_quality", "tech_intent", "semantic");
  push("tech_intent", "java_backend", "semantic");
  push("java_backend", "tech_intent", "semantic");
  push("tech_intent", "distributed_systems", "semantic");
  push("distributed_systems", "tech_intent", "semantic");
  push("rant_intent", "code_quality", "semantic");
  push("code_quality", "rant_intent", "semantic");
  push("rant_intent", "java_backend", "semantic");
  push("java_backend", "rant_intent", "semantic");
  push("rant_intent", "late_night_emo", "semantic");
  push("late_night_emo", "rant_intent", "semantic");
  push("casual_intent", "factory_games", "semantic");
  push("factory_games", "casual_intent", "semantic");
  push("casual_intent", "food_delivery", "semantic");
  push("food_delivery", "casual_intent", "semantic");
  push("casual_intent", "bean_cat", "semantic");
  push("bean_cat", "casual_intent", "semantic");

  push("happy", "chatty_when_close", "emotional");
  push("happy", "bean_cat", "emotional");
  push("happy", "casual_intent", "emotional");
  push("curious", "distributed_systems", "emotional");
  push("curious", "tech_feeds", "emotional");
  push("curious", "tech_intent", "emotional");
  push("irritable", "code_quality", "emotional");
  push("irritable", "java_backend", "emotional");
  push("irritable", "rant_intent", "emotional");
  push("hurt", "anti_stereotype", "emotional");
  push("hurt", "quiet_care", "emotional");
  push("emo", "late_night_emo", "emotional");
  push("emo", "food_delivery", "emotional");
  push("emo", "rant_intent", "emotional");

  push("morning", "lunch", "temporal");
  push("lunch", "afternoon", "temporal");
  push("afternoon", "evening", "temporal");
  push("evening", "late_night", "temporal");
  push("weekend", "evening", "temporal");

  push("morning", "java_backend", "causal");
  push("lunch", "food_delivery", "causal");
  push("evening", "casual_intent", "causal");
  push("late_night", "late_night_emo", "causal");
  push("weekend", "casual_intent", "causal");

  return edges;
}

const BUNDLED_EDGES = buildBundledEdges();

function makeNode(input: {
  id: string;
  content: string;
  type: BundledNodeType;
  emotionalValence: number;
  nowMs: number;
}): MemoryNode {
  return {
    id: input.id,
    content: input.content,
    type: input.type,
    embedding: [],
    activation_level: 0,
    activation_history: [input.nowMs],
    base_level_activation: Number.NEGATIVE_INFINITY,
    emotional_valence: input.emotionalValence,
    created_at: input.nowMs,
    last_activated_at: input.nowMs,
    metadata: {
      extracted_from: "bundled_default_graph"
    }
  };
}

export async function populateBundledDefaultGraph(input: {
  graph: MemoryGraphStore;
  cognitionConfig?: CognitionConfig;
  nowMs?: number;
}): Promise<{ created: boolean; nodeCount: number; edgeCount: number }> {
  if (input.graph.getStatistics().nodeCount > 0) {
    const stats = input.graph.getStatistics();
    return {
      created: false,
      nodeCount: stats.nodeCount,
      edgeCount: stats.edgeCount
    };
  }

  const cognitionConfig = input.cognitionConfig ?? DEFAULT_COGNITION_CONFIG;
  const nowMs = input.nowMs ?? Date.now();
  const contentToId = new Map<string, string>();

  await ensureFixedPersonNodes({
    graph: input.graph,
    nowMs
  });

  for (const node of BUNDLED_NODE_DEFINITIONS) {
    const created = input.graph.addNode(
      makeNode({
        id: randomUUID(),
        content: node.content,
        type: node.type,
        emotionalValence: node.emotionalValence,
        nowMs
      }),
      {
        skipDuplicateDetection: true
      }
    );
    contentToId.set(node.key, created.id);
  }

  for (const edge of BUNDLED_EDGES) {
    const sourceId = contentToId.get(edge.source);
    const targetId = contentToId.get(edge.target);
    if (!sourceId || !targetId) {
      continue;
    }

    input.graph.addEdge({
      id: randomUUID(),
      source: sourceId,
      target: targetId,
      relation_type: edge.type,
      weight: cognitionConfig.cold_start.initial_edge_weight,
      created_at: nowMs,
      last_activated_at: nowMs
    });
  }

  const stats = input.graph.getStatistics();
  return {
    created: true,
    nodeCount: stats.nodeCount,
    edgeCount: stats.edgeCount
  };
}

export async function ensureBundledDefaultGraph(input: {
  paths: CompanionPaths;
  cognitionConfig?: CognitionConfig;
  nowMs?: number;
}): Promise<{ created: boolean; nodeCount: number; edgeCount: number }> {
  const cognitionConfig = input.cognitionConfig ?? DEFAULT_COGNITION_CONFIG;
  const graph = new MemoryGraphStore(input.paths, cognitionConfig.graph_maintenance);
  const result = await populateBundledDefaultGraph({
    graph,
    cognitionConfig,
    nowMs: input.nowMs
  });
  if (result.created) {
    graph.serialize();
  }
  return result;
}
