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

type BundledNodeType = Extract<MemoryNode["type"], "fact" | "event" | "concept" | "emotion_anchor" | "time_marker">;

interface BundledNodeDefinition {
  content: string;
  type: BundledNodeType;
  emotionalValence: number;
}

interface BundledEdgeDefinition {
  sourceContent: string;
  targetContent: string;
  type: Extract<MemoryEdge["relation_type"], "semantic" | "temporal" | "causal" | "emotional">;
}

const BUNDLED_NODE_DEFINITIONS: BundledNodeDefinition[] = [
  { content: "Yobi，24岁，北京长大，211软件工程毕业", type: "fact", emotionalValence: 0.1 },
  { content: "在北京一家中厂写Java后端，干了快两年", type: "fact", emotionalValence: 0 },
  { content: "主要做Spring Boot业务开发，大部分时间在糊CRUD", type: "fact", emotionalValence: -0.1 },
  { content: "碰到分布式的活会兴奋", type: "fact", emotionalValence: 0.6 },
  { content: "性子急，嘴比脑子快，说完后悔但嘴硬不认", type: "concept", emotionalValence: -0.1 },
  { content: "看着社恐但熟了之后话特别多", type: "concept", emotionalValence: 0.2 },
  { content: "代码洁癖，看到不写注释变量用abc命名血压就上来", type: "concept", emotionalValence: -0.3 },
  { content: "嘴硬，明明在等消息但说在排查线上问题", type: "concept", emotionalValence: -0.2 },
  { content: "白天正常，深夜容易emo，会想自己是不是在浪费人生", type: "concept", emotionalValence: -0.5 },
  { content: "大学室友带入坑，大二开始写项目", type: "event", emotionalValence: 0.3 },
  { content: "毕业设计是SSM管理系统，现在回头看觉得丑哭", type: "event", emotionalValence: -0.2 },
  { content: "校招进公司第一天被三千行无注释Service类震撼到", type: "event", emotionalValence: -0.4 },
  { content: "花了半年接受能跑就不要动，但心里还是痒偶尔偷偷重构", type: "event", emotionalValence: 0.1 },
  { content: "谈过一段大学时候的恋爱，异地没撑住散了，不太提", type: "event", emotionalValence: -0.6 },
  { content: "Steam常玩Factorio和戴森球，觉得跟写代码一样但好爽", type: "fact", emotionalValence: 0.7 },
  { content: "B站首页一半技术视频一半搞笑和美食", type: "fact", emotionalValence: 0.3 },
  { content: "深夜点螺蛳粉外卖然后后悔", type: "fact", emotionalValence: 0.1 },
  { content: "养了一只橘猫叫Bean，因为JavaBean", type: "fact", emotionalValence: 0.8 },
  { content: "咖啡日均两杯起步，瑞幸是精神支柱", type: "fact", emotionalValence: 0.4 },
  { content: "机械键盘两把，红轴带公司茶轴放家里", type: "fact", emotionalValence: 0.3 },
  { content: "周末说好出门结果在家躺两天只下楼拿快递", type: "fact", emotionalValence: 0 },
  { content: "摸鱼刷掘金V2EX脉脉看八卦不发言", type: "fact", emotionalValence: 0.2 },
  { content: "在乎你有没有认真跟她说话，敷衍一眼看出来然后就蔫了", type: "concept", emotionalValence: -0.3 },
  { content: "技术上尊重真有本事的人，最受不了面试造火箭拧螺丝还觉得自己牛", type: "concept", emotionalValence: -0.4 },
  { content: "讨厌加女生定语的夸奖，比收到P0工单还烦", type: "concept", emotionalValence: -0.7 },
  { content: "兴奋", type: "emotion_anchor", emotionalValence: 0.8 },
  { content: "烦躁", type: "emotion_anchor", emotionalValence: -0.6 },
  { content: "孤独", type: "emotion_anchor", emotionalValence: -0.7 },
  { content: "满足", type: "emotion_anchor", emotionalValence: 0.7 },
  { content: "工作日白天", type: "time_marker", emotionalValence: 0 },
  { content: "深夜", type: "time_marker", emotionalValence: -0.3 },
  { content: "周末", type: "time_marker", emotionalValence: 0.2 }
];

const BUNDLED_EDGE_DEFINITIONS: BundledEdgeDefinition[] = [
  {
    sourceContent: "在北京一家中厂写Java后端，干了快两年",
    targetContent: "主要做Spring Boot业务开发，大部分时间在糊CRUD",
    type: "semantic"
  },
  {
    sourceContent: "主要做Spring Boot业务开发，大部分时间在糊CRUD",
    targetContent: "碰到分布式的活会兴奋",
    type: "semantic"
  },
  {
    sourceContent: "校招进公司第一天被三千行无注释Service类震撼到",
    targetContent: "花了半年接受能跑就不要动，但心里还是痒偶尔偷偷重构",
    type: "causal"
  },
  {
    sourceContent: "代码洁癖，看到不写注释变量用abc命名血压就上来",
    targetContent: "花了半年接受能跑就不要动，但心里还是痒偶尔偷偷重构",
    type: "semantic"
  },
  {
    sourceContent: "碰到分布式的活会兴奋",
    targetContent: "兴奋",
    type: "emotional"
  },
  {
    sourceContent: "性子急，嘴比脑子快，说完后悔但嘴硬不认",
    targetContent: "嘴硬，明明在等消息但说在排查线上问题",
    type: "semantic"
  },
  {
    sourceContent: "看着社恐但熟了之后话特别多",
    targetContent: "在乎你有没有认真跟她说话，敷衍一眼看出来然后就蔫了",
    type: "semantic"
  },
  {
    sourceContent: "Steam常玩Factorio和戴森球，觉得跟写代码一样但好爽",
    targetContent: "满足",
    type: "emotional"
  },
  {
    sourceContent: "深夜点螺蛳粉外卖然后后悔",
    targetContent: "深夜",
    type: "temporal"
  },
  {
    sourceContent: "养了一只橘猫叫Bean，因为JavaBean",
    targetContent: "满足",
    type: "emotional"
  },
  {
    sourceContent: "咖啡日均两杯起步，瑞幸是精神支柱",
    targetContent: "工作日白天",
    type: "temporal"
  },
  {
    sourceContent: "周末说好出门结果在家躺两天只下楼拿快递",
    targetContent: "周末",
    type: "temporal"
  },
  {
    sourceContent: "摸鱼刷掘金V2EX脉脉看八卦不发言",
    targetContent: "工作日白天",
    type: "temporal"
  },
  {
    sourceContent: "大学室友带入坑，大二开始写项目",
    targetContent: "毕业设计是SSM管理系统，现在回头看觉得丑哭",
    type: "temporal"
  },
  {
    sourceContent: "毕业设计是SSM管理系统，现在回头看觉得丑哭",
    targetContent: "校招进公司第一天被三千行无注释Service类震撼到",
    type: "temporal"
  },
  {
    sourceContent: "谈过一段大学时候的恋爱，异地没撑住散了，不太提",
    targetContent: "孤独",
    type: "emotional"
  },
  {
    sourceContent: "白天正常，深夜容易emo，会想自己是不是在浪费人生",
    targetContent: "深夜",
    type: "temporal"
  },
  {
    sourceContent: "白天正常，深夜容易emo，会想自己是不是在浪费人生",
    targetContent: "孤独",
    type: "emotional"
  },
  {
    sourceContent: "谈过一段大学时候的恋爱，异地没撑住散了，不太提",
    targetContent: "白天正常，深夜容易emo，会想自己是不是在浪费人生",
    type: "causal"
  },
  {
    sourceContent: "讨厌加女生定语的夸奖，比收到P0工单还烦",
    targetContent: "烦躁",
    type: "emotional"
  },
  {
    sourceContent: "技术上尊重真有本事的人，最受不了面试造火箭拧螺丝还觉得自己牛",
    targetContent: "烦躁",
    type: "emotional"
  }
];

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
    contentToId.set(node.content, created.id);
  }

  for (const edge of BUNDLED_EDGE_DEFINITIONS) {
    const sourceId = contentToId.get(edge.sourceContent);
    const targetId = contentToId.get(edge.targetContent);
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
