import { generateObject, generateText, stepCountIs, streamText, type ToolSet } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import type {
  AppConfig,
  ModelRoute,
  ProviderConfig
} from "@shared/types";
import type { HistoryMessage, MemoryFact } from "@shared/types";

type Purpose = keyof AppConfig["modelRouting"];

interface ChatReplyInput {
  characterPrompt: string;
  userMessage: string;
  recentHistory: HistoryMessage[];
  memoryFacts: MemoryFact[];
  userPhotoUrl?: string;
  tools?: ToolSet;
  stream?: ChatReplyStreamListener;
}

export interface ChatReplyStreamListener {
  onReasoningDelta?: (delta: string) => void;
  onTextDelta?: (delta: string) => void;
  onToolCall?: (payload: {
    toolCallId: string;
    toolName: string;
    input: unknown;
  }) => void;
  onToolResult?: (payload: {
    toolCallId: string;
    toolName: string;
    input: unknown;
    success: boolean;
    output?: unknown;
    error?: string;
  }) => void;
}

interface ResolvedModel {
  model: any;
  providerKind: ProviderConfig["kind"];
}

interface ProactiveDecisionInput {
  characterPrompt: string;
  recentHistory: HistoryMessage[];
  memoryFacts: MemoryFact[];
  reason: string;
  topicHints: string;
}

const memoryFactItemSchema = z.object({
  content: z.string().min(1),
  confidence: z.number().min(0).max(1)
});

const proactiveSchema = z.object({
  shouldSpeak: z.boolean(),
  reason: z.string().min(1),
  message: z.string().optional(),
  usedTopicIndex: z.number().int().min(1).nullable().optional()
});

export class LlmRouter {
  constructor(private readonly getConfig: () => AppConfig) {}

  async generateChatReply(input: ChatReplyInput): Promise<string> {
    const config = this.getConfig();
    const route = config.modelRouting.chat;
    const resolved = this.getModel(route, "chat");

    const system = [
      input.characterPrompt,
      "你会根据长期记忆和最近上下文回复。",
      "你可以在需要时输出这些标记：",
      "- [voice]...[/voice] 表示这段适合语音发送。",
      "- [reminder]{\"time\":\"ISO8601\",\"text\":\"提醒内容\"}[/reminder] 创建提醒。",
      "- [happy]/[sad]/[shy]/[angry]/[surprised]/[excited]/[calm]/[idle] 用于桌宠情绪。",
      "执行浏览器任务时优先采用：navigate/open -> snapshot -> act 的节奏，保证动作可解释。",
      "除标记外不要解释标记含义。",
      `长期记忆:\n${this.formatFacts(input.memoryFacts)}`
    ].join("\n\n");

    const prompt = [
      this.formatHistory(input.recentHistory),
      `用户新消息: ${input.userMessage}`
    ].join("\n\n");

    const generationOptions: Record<string, unknown> = {
      model: resolved.model,
      maxOutputTokens: 400,
      system
    };

    if (input.tools && Object.keys(input.tools).length > 0) {
      generationOptions.tools = input.tools;
      generationOptions.toolChoice = "auto";
      generationOptions.stopWhen = stepCountIs(8);
      if (resolved.providerKind === "openai" || resolved.providerKind === "custom-openai") {
        generationOptions.providerOptions = {
          openai: {
            store: resolved.providerKind === "custom-openai" ? false : true,
            parallelToolCalls: false
          }
        };
      }
    }

    if (this.supportsTemperature(route)) {
      generationOptions.temperature = 0.75;
    }

    const content: Array<{ type: "text"; text: string } | { type: "image"; image: string }> = [
      {
        type: "text",
        text: prompt
      }
    ];

    if (input.userPhotoUrl) {
      content.push({
        type: "image",
        image: input.userPhotoUrl
      });
    }

    const requestPayload = input.userPhotoUrl
      ? ({
          ...generationOptions,
          messages: [
            {
              role: "user",
              content
            }
          ]
        } as any)
      : ({
          ...generationOptions,
          prompt
        } as any);

    if (!input.stream) {
      const response = await generateText(requestPayload);
      const text = response.text.trim();
      return text || "操作已完成。";
    }

    const STREAM_IDLE_TIMEOUT_MS = 12_000;
    const abortController = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let bufferedText = "";
    let abortedByIdle = false;

    const refreshIdleTimer = (): void => {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        abortedByIdle = true;
        abortController.abort("stream-idle-timeout");
      }, STREAM_IDLE_TIMEOUT_MS);
    };

    const response = streamText({
      ...(requestPayload as Record<string, unknown>),
      abortSignal: abortController.signal
    } as any);

    refreshIdleTimer();
    try {
      for await (const part of response.fullStream) {
        refreshIdleTimer();

        if (part.type === "reasoning-delta") {
          input.stream.onReasoningDelta?.(part.text);
          continue;
        }

        if (part.type === "text-delta") {
          bufferedText += part.text;
          input.stream.onTextDelta?.(part.text);
          continue;
        }

        if (part.type === "tool-call") {
          input.stream.onToolCall?.({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input
          });
          continue;
        }

        if (part.type === "tool-result") {
          input.stream.onToolResult?.({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            success: true,
            output: part.output
          });
          continue;
        }

        if (part.type === "tool-error") {
          input.stream.onToolResult?.({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            success: false,
            error:
              part.error instanceof Error
                ? part.error.message
                : typeof part.error === "string"
                  ? part.error
                  : "工具执行失败"
          });
        }
      }
    } catch (error) {
      if (!abortedByIdle) {
        throw error;
      }
    } finally {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    }

    if (abortedByIdle) {
      void response.text.catch(() => undefined);
      const partialText = bufferedText.trim();
      if (partialText) {
        return partialText;
      }
      throw new Error("流式输出空闲超时");
    }

    const text = (await response.text).trim() || bufferedText.trim();
    return text || "操作已完成。";
  }

  async extractFacts(input: {
    recentHistory: HistoryMessage[];
    existingFacts: MemoryFact[];
  }): Promise<Array<{ content: string; confidence: number }>> {
    const config = this.getConfig();
    const resolved = this.getModel(config.modelRouting.memory, "memory");
    const maxFacts = Math.max(10, Math.min(500, Math.round(config.memory.maxFacts)));
    const memorySchema = z.object({
      facts: z.array(memoryFactItemSchema).max(maxFacts)
    });
    const system = `你负责维护用户的长期记忆。下面是现有记忆和最近对话。
请输出一份更新后的完整记忆列表（最多 ${maxFacts} 条）：
- 如果新对话中出现了和现有记忆语义相同的信息，合并为一条，根据新信息调整置信度
- 如果某条现有记忆被新对话否定了（比如用户说换了工作），更新内容或降低置信度
- 如果新对话中有值得记住的新事实，新增
- 没有变化的现有记忆原样保留`;
    const prompt = [
      `现有记忆:\n${this.formatFacts(input.existingFacts)}`,
      `最近对话:\n${this.formatHistory(input.recentHistory)}`
    ].join("\n\n");

    const result = await generateObject({
      model: resolved.model,
      schema: memorySchema,
      system,
      prompt
    } as any);

    return memorySchema.parse(result.object ?? {}).facts;
  }

  async recall(input: {
    facts: MemoryFact[];
    recentHistory: HistoryMessage[];
    currentTime: string;
  }): Promise<{ topics: string[] }> {
    const config = this.getConfig();
    const resolved = this.getModel(config.modelRouting.memory, "memory");
    const system = `你是 Yobi。现在用户不在线，你有一段独处时间。
回顾你对用户的记忆和最近对话，想想：
1. 有没有用户提过但你还没跟进的事（考试、面试、约会、旅行计划等）
2. 最近对话中你注意到的情绪或状态变化
3. 有没有想下次聊天时自然提起的话题
输出 0-2 个最值得说的话题。每个话题是一句你会直接发给用户的话，口语化、简短。
没有就返回空数组，不要硬凑。`;

    const prompt = [
      `当前时间: ${input.currentTime}`,
      `记忆:\n${this.formatFacts(input.facts)}`,
      `最近对话:\n${this.formatHistory(input.recentHistory)}`
    ].join("\n\n");

    const schema = z.object({
      topics: z.array(z.string()).max(2)
    });

    const result = await generateObject({
      model: resolved.model,
      schema,
      system,
      prompt
    } as any);

    return schema.parse(result.object ?? {
      topics: []
    });
  }

  async filterNovelTopics(input: {
    candidates: string[];
    existingTopics: string[];
  }): Promise<string[]> {
    const candidates = input.candidates
      .map((item) => item.trim())
      .filter(Boolean);

    if (candidates.length === 0) {
      return [];
    }

    const uniqueCandidates: string[] = [];
    const seenCandidateKeys = new Set<string>();
    for (const candidate of candidates) {
      const key = candidate.toLowerCase();
      if (seenCandidateKeys.has(key)) {
        continue;
      }
      seenCandidateKeys.add(key);
      uniqueCandidates.push(candidate);
    }

    const existingTopics = input.existingTopics
      .map((item) => item.trim())
      .filter(Boolean);
    if (existingTopics.length === 0) {
      return uniqueCandidates;
    }

    const config = this.getConfig();
    const resolved = this.getModel(config.modelRouting.memory, "memory");
    const schema = z.object({
      keepIndexes: z.array(z.number().int().min(1).max(uniqueCandidates.length)).max(uniqueCandidates.length)
    });
    const system = `你是话题去重器。你会根据已有话题和候选话题，判断哪些候选可以保留。
要求：
- 语义相似就算重复（即使措辞不同）
- 候选之间也要去重
- 只返回“应该保留”的候选序号
- 不要改写话题文本，不要新增候选
- 序号从 1 开始`;
    const prompt = [
      `已有话题:\n${existingTopics.map((topic, index) => `${index + 1}. ${topic}`).join("\n")}`,
      `候选话题:\n${uniqueCandidates.map((topic, index) => `${index + 1}. ${topic}`).join("\n")}`,
      "返回 keepIndexes。若都重复，返回空数组。"
    ].join("\n\n");

    const result = await generateObject({
      model: resolved.model,
      schema,
      system,
      prompt
    } as any);

    const parsed = schema.parse(result.object ?? {
      keepIndexes: []
    });
    const keepIndexes = Array.from(new Set(parsed.keepIndexes))
      .filter((index) => index >= 1 && index <= uniqueCandidates.length)
      .sort((a, b) => a - b);

    return keepIndexes.map((index) => uniqueCandidates[index - 1]);
  }

  async planWander(input: {
    facts: MemoryFact[];
  }): Promise<{ query: string; reason: string } | null> {
    const config = this.getConfig();
    const resolved = this.getModel(config.modelRouting.memory, "memory");
    const system = `你是 Yobi。根据你对用户的了解，想一个用户可能感兴趣的搜索关键词。
要求：和用户的兴趣/近况相关，具体（不要太泛），中文。
如果用户记忆太少或没什么好搜的，返回 null。`;

    const prompt = `用户记忆:\n${this.formatFacts(input.facts)}`;
    const schema = z.object({
      query: z.string().nullable(),
      reason: z.string()
    });

    const result = await generateObject({
      model: resolved.model,
      schema,
      system,
      prompt
    } as any);

    const parsed = schema.parse(result.object ?? {
      query: null,
      reason: ""
    });

    if (!parsed.query) {
      return null;
    }

    return {
      query: parsed.query,
      reason: parsed.reason
    };
  }

  async digestWander(input: {
    query: string;
    reason: string;
    searchSnippets: string;
  }): Promise<string | null> {
    const config = this.getConfig();
    const resolved = this.getModel(config.modelRouting.memory, "memory");
    const system = `你是 Yobi。你刚搜了一个和用户兴趣相关的话题，从搜索结果里挑一个最有意思的点，
用一句口语化的话概括，像是朋友闲聊时会说的那种。
如果搜索结果没什么有价值的，返回空字符串。`;

    const prompt = `搜索词: ${input.query}
原因: ${input.reason}
结果摘要:
${input.searchSnippets}`;

    const result = await generateText({
      model: resolved.model,
      system,
      prompt,
      maxOutputTokens: 100
    } as any);

    const text = result.text.trim();
    return text || null;
  }

  async decideProactive(input: ProactiveDecisionInput): Promise<{
    shouldSpeak: boolean;
    reason: string;
    message?: string;
    usedTopicIndex?: number | null;
  }> {
    const config = this.getConfig();
    const resolved = this.getModel(config.modelRouting.chat, "chat");
    const system = `你是 Yobi。现在你有机会主动给用户发一条消息。
大多数时候不发才是对的。如果要发，可以是：
- 用下面积攒的话题（如果有的话）
- 根据时间说点应景的
- 纯粹闲聊
不要为了说话而说话。不要每次都问"你在干嘛"。
做出判断就行，不要解释原因。`;
    const prompt = [
      input.characterPrompt,
      `触发原因: ${input.reason}`,
      `当前时间: ${new Date().toLocaleString("zh-CN")}`,
      `积攒的话题:\n${input.topicHints}`,
      "如果你用了上面的话题，在 usedTopicIndex 填对应序号（从 1 开始），没用就填 null。",
      `长期记忆:\n${this.formatFacts(input.memoryFacts)}`,
      `最近对话:\n${this.formatHistory(input.recentHistory)}`
    ].join("\n\n");

    const result = await generateObject({
      model: resolved.model,
      schema: proactiveSchema,
      system,
      prompt
    } as any);

    return proactiveSchema.parse(result.object ?? {});
  }

  private getModel(route: ModelRoute, purpose: Purpose): ResolvedModel {
    const config = this.getConfig();
    const provider = config.providers.find((candidate) => candidate.id === route.providerId);
    if (!provider) {
      throw new Error(`Missing provider for ${purpose}: ${route.providerId}`);
    }

    return this.makeModel(provider, route.model);
  }

  private makeModel(provider: ProviderConfig, model: string): ResolvedModel {
    if (!provider.enabled) {
      throw new Error(`Provider ${provider.id} is disabled`);
    }

    if (provider.kind === "anthropic") {
      return {
        model: createAnthropic({
          apiKey: provider.apiKey
        })(model),
        providerKind: provider.kind
      };
    }

    if (provider.kind === "openrouter") {
      return {
        model: createOpenRouter({
          apiKey: provider.apiKey
        }).chat(model),
        providerKind: provider.kind
      };
    }

    if (provider.kind === "custom-openai") {
      if (!provider.baseUrl) {
        throw new Error(`Provider ${provider.id} missing baseUrl`);
      }

      const normalizedBaseUrl = this.normalizeCustomOpenAIBaseUrl(provider.baseUrl);
      const client = createOpenAI({
        apiKey: provider.apiKey,
        baseURL: normalizedBaseUrl
      });

      return {
        model: this.selectOpenAIEndpoint(client, provider.apiMode, model),
        providerKind: provider.kind
      };
    }

    if (provider.kind === "openai") {
      const client = createOpenAI({
        apiKey: provider.apiKey
      });

      return {
        model: this.selectOpenAIEndpoint(client, provider.apiMode, model),
        providerKind: provider.kind
      };
    }

    return {
      model: createOpenAI({
        apiKey: provider.apiKey
      }).chat(model),
      providerKind: provider.kind
    };
  }

  private supportsTemperature(route: ModelRoute): boolean {
    const modelId = route.model.trim().toLowerCase();
    if (!modelId) {
      return true;
    }

    if (modelId.startsWith("gpt-5")) {
      return false;
    }

    if (modelId.startsWith("o1") || modelId.startsWith("o3") || modelId.startsWith("o4")) {
      return false;
    }

    return !modelId.includes("reasoning");
  }

  private formatHistory(history: HistoryMessage[]): string {
    if (history.length === 0) {
      return "(暂无历史)";
    }

    return history
      .map((message) => {
        const role = message.role === "assistant" ? "你" : message.role === "user" ? "用户" : "系统";
        return `[${message.timestamp}] ${role}: ${message.text}`;
      })
      .join("\n");
  }

  private formatFacts(facts: MemoryFact[]): string {
    if (facts.length === 0) {
      return "(暂无长期记忆)";
    }

    return facts
      .map((fact, index) => `${index + 1}. ${fact.content} (置信度 ${fact.confidence.toFixed(2)})`)
      .join("\n");
  }

  private normalizeCustomOpenAIBaseUrl(raw: string): string {
    const input = raw.trim();
    if (!input) {
      return input;
    }

    let parsed: URL;
    try {
      parsed = new URL(input);
    } catch {
      return input;
    }

    const pathname = parsed.pathname.trim();
    if (pathname === "" || pathname === "/") {
      parsed.pathname = "/v1";
      return parsed.toString().replace(/\/$/, "");
    }

    return input.replace(/\/$/, "");
  }

  private selectOpenAIEndpoint(
    client: ReturnType<typeof createOpenAI>,
    apiMode: ProviderConfig["apiMode"],
    model: string
  ) {
    if (apiMode === "responses") {
      return client.responses(model as any);
    }

    return client.chat(model as any);
  }
}
