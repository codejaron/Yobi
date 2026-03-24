import { generateObject, generateText } from "ai";
import { z } from "zod";
import { resolveOpenAIStoreOption } from "@main/core/provider-utils";
import type { ModelFactory } from "@main/core/model-factory";
import type { AppConfig, HistoryMessage, UserProfile } from "@shared/types";
import { reportCognitionTokenUsage } from "../token-usage";
import type {
  BubbleEvaluationDimensions,
  CognitionConfig,
  MemoryEdge,
  MemoryNode,
  ThoughtBubble
} from "@shared/cognition";
import { ThoughtPool } from "../thoughts/thought-bubble";
import { roughFilter } from "./rough-filter";

const evaluationSchema = z.object({
  relevance: z.number().min(1).max(5),
  information_gap: z.number().min(1).max(5),
  timing: z.number().min(1).max(5),
  novelty: z.number().min(1).max(5),
  expected_impact: z.number().min(1).max(5),
  relationship_fit: z.number().min(1).max(5)
}).strict();

interface SummaryGraphLookup {
  getNode(id: string): MemoryNode | undefined;
  getEdgesBetween(source: string, target: string): MemoryEdge[];
}

export interface ExpressionEvaluationInput {
  bubble: ThoughtBubble;
  thoughtPool: ThoughtPool;
  graph: SummaryGraphLookup;
  recentDialogue: HistoryMessage[];
  userProfile: UserProfile;
  modelFactory: ModelFactory;
  appConfig: AppConfig;
  config: CognitionConfig;
  lastExpressionTime: number;
  userOnline: boolean;
}

export interface ExpressionEvaluationResult {
  text: string | null;
  bubblePassedFilter: boolean;
  summary: string | null;
  evaluationScore: number | null;
  evaluationDimensions: BubbleEvaluationDimensions | null;
  reason: string;
}

function averageDimensions(dimensions: BubbleEvaluationDimensions): number {
  return (
    dimensions.relevance +
    dimensions.information_gap +
    dimensions.timing +
    dimensions.novelty +
    dimensions.expected_impact +
    dimensions.relationship_fit
  ) / 6;
}

function formatRecentDialogue(messages: HistoryMessage[]): string {
  return messages
    .slice(-5)
    .map((message) => `${message.role}: ${message.text}`)
    .join("\n");
}

function compareActivatedNodes(
  left: { node_id: string; activation: number },
  right: { node_id: string; activation: number }
): number {
  if (right.activation !== left.activation) {
    return right.activation - left.activation;
  }
  return left.node_id.localeCompare(right.node_id);
}

function formatActivation(value: number): string {
  return value.toFixed(2);
}

export function buildBubbleSummaryContext(bubble: ThoughtBubble, graph: SummaryGraphLookup): string {
  const topActivated = [...bubble.activated_nodes]
    .sort(compareActivatedNodes)
    .slice(0, 6)
    .map((item) => {
      const node = graph.getNode(item.node_id);
      return {
        id: item.node_id,
        content: node?.content?.trim() || "未知记忆",
        type: node?.type ?? "concept",
        activation: item.activation
      };
    });
  const sourceSeeds = bubble.source_seeds
    .map((seedId) => graph.getNode(seedId)?.content?.trim())
    .filter((seed): seed is string => Boolean(seed));
  const topNodeIds = new Set(topActivated.map((node) => node.id));
  const edgeSeen = new Set<string>();
  const relatedPaths: Array<{ source: string; target: string; relation: MemoryEdge["relation_type"]; score: number }> =
    [];

  for (const sourceNode of topActivated) {
    for (const targetNode of topActivated) {
      if (sourceNode.id === targetNode.id || !topNodeIds.has(sourceNode.id) || !topNodeIds.has(targetNode.id)) {
        continue;
      }

      for (const edge of graph.getEdgesBetween(sourceNode.id, targetNode.id)) {
        const key = `${edge.source}:${edge.relation_type}:${edge.target}`;
        if (edgeSeen.has(key)) {
          continue;
        }
        edgeSeen.add(key);
        relatedPaths.push({
          source: sourceNode.content,
          target: targetNode.content,
          relation: edge.relation_type,
          score: sourceNode.activation + targetNode.activation
        });
      }
    }
  }

  relatedPaths.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    const leftKey = `${left.source}:${left.relation}:${left.target}`;
    const rightKey = `${right.source}:${right.relation}:${right.target}`;
    return leftKey.localeCompare(rightKey);
  });

  const sections: string[] = [];
  if (sourceSeeds.length > 0) {
    sections.push(["种子记忆：", ...sourceSeeds.slice(0, 4).map((seed) => `- ${seed}`)].join("\n"));
  }
  if (topActivated.length > 0) {
    sections.push([
      "高激活记忆：",
      ...topActivated.map(
        (node) => `- ${node.content}（${node.type}，激活 ${formatActivation(node.activation)}）`
      )
    ].join("\n"));
  }
  if (relatedPaths.length > 0) {
    sections.push([
      "关联路径：",
      ...relatedPaths.slice(0, 6).map((path) => `- ${path.source} --${path.relation}--> ${path.target}`)
    ].join("\n"));
  }

  if (sections.length === 0) {
    return "没有可读的联想内容。";
  }

  return sections.join("\n\n");
}

export async function evaluateAndExpress(input: ExpressionEvaluationInput): Promise<ExpressionEvaluationResult> {
  if (!roughFilter(input.bubble, input.lastExpressionTime, input.userOnline, input.config)) {
    return {
      text: null,
      bubblePassedFilter: false,
      summary: null,
      evaluationScore: null,
      evaluationDimensions: null,
      reason: "rough-filter-blocked"
    };
  }

  const cognitionModel = input.modelFactory.getCognitionModel();
  const bubbleSummaryContext = buildBubbleSummaryContext(input.bubble, input.graph);
  const summaryPrompt = [
    "以下是一次联想气泡的可读上下文，请用一句中文概括这次联想的核心主题。",
    "要求：不要提 node_id、UUID、激活值、路径、图谱、节点这些词，直接总结 Yobi 此刻在想什么。",
    bubbleSummaryContext
  ].join("\n\n");
  const summaryTextResult = await generateText({
    model: cognitionModel,
    providerOptions: resolveOpenAIStoreOption(input.appConfig, "cognition"),
    prompt: summaryPrompt,
    maxOutputTokens: 120
  });
  reportCognitionTokenUsage({
    usage: summaryTextResult.usage,
    inputText: summaryPrompt,
    outputText: summaryTextResult.text
  });

  const summaryText = summaryTextResult.text.trim();
  input.thoughtPool.matureBubble(input.bubble.id, summaryText);

  const evaluationPrompt = [
    "你是一个 AI 伙伴，正在考虑是否主动对用户说以下这个想法。",
    "请从以下六个维度打 1-5 分并返回 JSON：relevance、information_gap、timing、novelty、expected_impact、relationship_fit。",
    `想法内容：${summaryText}`,
    `当前时间：${new Date().toISOString()}`,
    `用户画像：${JSON.stringify(input.userProfile)}`,
    `最近对话：\n${formatRecentDialogue(input.recentDialogue)}`
  ].join("\n");
  const evaluation = await generateObject({
    model: cognitionModel,
    providerOptions: resolveOpenAIStoreOption(input.appConfig, "cognition"),
    schema: evaluationSchema,
    prompt: evaluationPrompt,
    maxOutputTokens: 200
  });
  reportCognitionTokenUsage({
    usage: evaluation.usage,
    inputText: evaluationPrompt,
    outputText: JSON.stringify(evaluation.object ?? {})
  });

  const dimensions = evaluationSchema.parse(evaluation.object ?? {});
  const score = averageDimensions(dimensions);

  if (score < 3.5) {
    return {
      text: null,
      bubblePassedFilter: true,
      summary: summaryText,
      evaluationScore: score,
      evaluationDimensions: dimensions,
      reason: "score-below-threshold"
    };
  }

  const finalPrompt = `你现在自发想到了一个话题想和用户分享（不是回答用户的问题）。想法是：${summaryText}。请用自然、口语化的方式说出来，一两句话即可，不要有“我想到了”这种前缀。`;
  const finalExpression = await generateText({
    model: input.modelFactory.getChatModel(),
    providerOptions: resolveOpenAIStoreOption(input.appConfig, "chat"),
    prompt: finalPrompt,
    maxOutputTokens: 120
  });
  reportCognitionTokenUsage({
    usage: finalExpression.usage,
    inputText: finalPrompt,
    outputText: finalExpression.text
  });

  return {
    text: finalExpression.text.trim() || null,
    bubblePassedFilter: true,
    summary: summaryText,
    evaluationScore: score,
    evaluationDimensions: dimensions,
    reason: "expressed"
  };
}
