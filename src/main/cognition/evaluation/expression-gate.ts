import { generateObject, generateText } from "ai";
import { z } from "zod";
import { resolveOpenAIStoreOption } from "@main/core/provider-utils";
import type { ModelFactory } from "@main/core/model-factory";
import type { AppConfig, HistoryMessage, UserProfile } from "@shared/types";
import type { BubbleEvaluationDimensions, CognitionConfig, ThoughtBubble } from "@shared/cognition";
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

export interface ExpressionEvaluationInput {
  bubble: ThoughtBubble;
  thoughtPool: ThoughtPool;
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
  const summaryTextResult = await generateText({
    model: cognitionModel,
    providerOptions: resolveOpenAIStoreOption(input.appConfig, "cognition"),
    prompt: `以下是一组被激活的记忆节点及其关联路径，请用一句话概括这次联想的核心主题：${JSON.stringify(
      input.bubble.activated_nodes,
      null,
      2
    )}`,
    maxOutputTokens: 120
  });

  const summaryText = summaryTextResult.text.trim();
  input.thoughtPool.matureBubble(input.bubble.id, summaryText);

  const evaluation = await generateObject({
    model: cognitionModel,
    providerOptions: resolveOpenAIStoreOption(input.appConfig, "cognition"),
    schema: evaluationSchema,
    prompt: [
      "你是一个 AI 伙伴，正在考虑是否主动对用户说以下这个想法。",
      "请从以下六个维度打 1-5 分并返回 JSON：relevance、information_gap、timing、novelty、expected_impact、relationship_fit。",
      `想法内容：${summaryText}`,
      `当前时间：${new Date().toISOString()}`,
      `用户画像：${JSON.stringify(input.userProfile)}`,
      `最近对话：\n${formatRecentDialogue(input.recentDialogue)}`
    ].join("\n"),
    maxOutputTokens: 200
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

  const finalExpression = await generateText({
    model: input.modelFactory.getChatModel(),
    providerOptions: resolveOpenAIStoreOption(input.appConfig, "chat"),
    prompt: `你现在自发想到了一个话题想和用户分享（不是回答用户的问题）。想法是：${summaryText}。请用自然、口语化的方式说出来，一两句话即可，不要有“我想到了”这种前缀。`,
    maxOutputTokens: 120
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
