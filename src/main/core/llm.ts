import { generateObject, generateText, stepCountIs, type ToolSet } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import type {
  ActivitySnapshot,
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
  activity?: ActivitySnapshot | null;
  userPhotoUrl?: string;
  tools?: ToolSet;
}

interface ResolvedModel {
  model: any;
  providerKind: ProviderConfig["kind"];
}

interface ProactiveDecisionInput {
  characterPrompt: string;
  recentHistory: HistoryMessage[];
  memoryFacts: MemoryFact[];
  activity?: ActivitySnapshot | null;
  reason: string;
}

const memorySchema = z.object({
  facts: z.array(
    z.object({
      content: z.string().min(1),
      confidence: z.number().min(0).max(1)
    })
  )
});

const proactiveSchema = z.object({
  shouldSpeak: z.boolean(),
  reason: z.string().min(1),
  message: z.string().optional()
});

export class LlmRouter {
  constructor(private readonly getConfig: () => AppConfig) {}

  async generateChatReply(input: ChatReplyInput): Promise<string> {
    const config = this.getConfig();
    const route = config.modelRouting.chat;
    const resolved = this.getModel(route, "chat");
    const inlineSystem = resolved.providerKind === "custom-openai";

    const system = [
      input.characterPrompt,
      "你会根据长期记忆和最近上下文回复，简短自然。",
      "你可以在需要时输出这些标记：",
      "- [voice]...[/voice] 表示这段适合语音发送。",
      "- [reminder]{\"time\":\"ISO8601\",\"text\":\"提醒内容\"}[/reminder] 创建提醒。",
      "- [happy]/[sad]/[shy]/[angry]/[surprised]/[excited]/[calm]/[idle] 用于桌宠情绪。",
      "强规则1：只有当用户明确要求语音/朗读时，才允许输出 [voice]...[/voice]。",
      "强规则1补充：用户没有明确要求语音时，严禁输出 [voice] 标签。",
      "如果用户要求你打开网页、点击按钮、填表、执行系统命令或读写文件，你可以调用可用工具完成，再基于工具结果回复。",
      "执行浏览器任务时优先采用：navigate/open -> snapshot -> act 的节奏，保证动作可解释。",
      "除标记外不要解释标记含义。",
      `长期记忆:\n${this.formatFacts(input.memoryFacts)}`,
      input.activity
        ? `当前屏幕状态: ${input.activity.summary} (应用: ${input.activity.app} / 标题: ${input.activity.title})`
        : "当前屏幕状态: 未知"
    ].join("\n\n");

    const prompt = [
      this.formatHistory(input.recentHistory),
      `用户新消息: ${input.userMessage}`
    ].join("\n\n");

    const generationOptions: Record<string, unknown> = {
      model: resolved.model,
      maxOutputTokens: 400
    };

    if (!inlineSystem) {
      generationOptions.system = system;
    }

    if (input.tools && Object.keys(input.tools).length > 0) {
      generationOptions.tools = input.tools;
      generationOptions.toolChoice = "auto";
      generationOptions.stopWhen = stepCountIs(8);
      if (resolved.providerKind === "openai" || resolved.providerKind === "custom-openai") {
        generationOptions.providerOptions = {
          openai: {
            store: true,
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
        text: inlineSystem ? `${system}\n\n${prompt}` : prompt
      }
    ];

    if (input.userPhotoUrl) {
      content.push({
        type: "image",
        image: input.userPhotoUrl
      });
    }

    const response = await generateText(
      input.userPhotoUrl
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
            prompt: inlineSystem ? `${system}\n\n${prompt}` : prompt
          } as any)
    );

    const text = response.text.trim();
    return text || "操作已完成。";
  }

  async describeActivity(input: {
    appName: string;
    windowTitle: string;
    screenshotBase64: string;
  }): Promise<string> {
    const config = this.getConfig();
    const resolved = this.getModel(config.modelRouting.perception, "perception");
    const inlineSystem = resolved.providerKind === "custom-openai";
    const system =
      "你是桌面活动观察器。输出一句中文，描述用户当前在做什么。不要夸张，不要建议。";
    const context = `当前窗口应用名: ${input.appName}; 窗口标题: ${input.windowTitle}`;

    const result = await generateText({
      model: resolved.model,
      system: inlineSystem ? undefined : system,
      maxOutputTokens: 80,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: inlineSystem ? `${system}\n\n${context}` : context
            },
            {
              type: "image",
              image: `data:image/jpeg;base64,${input.screenshotBase64}`
            }
          ]
        }
      ]
    } as any);

    return result.text.replace(/\s+/g, " ").trim();
  }

  async extractFacts(input: {
    recentHistory: HistoryMessage[];
    existingFacts: MemoryFact[];
  }): Promise<Array<{ content: string; confidence: number }>> {
    const config = this.getConfig();
    const resolved = this.getModel(config.modelRouting.memory, "memory");
    const inlineSystem = resolved.providerKind === "custom-openai";
    const system =
      "你负责提炼长期记忆。仅提炼相对稳定、对后续陪伴有帮助的用户事实。避免短期任务和敏感隐私。";
    const prompt = [
      `现有记忆:\n${this.formatFacts(input.existingFacts)}`,
      `最近对话:\n${this.formatHistory(input.recentHistory)}`,
      "输出最多 8 条事实。"
    ].join("\n\n");

    const result = await generateObject({
      model: resolved.model,
      schema: memorySchema,
      system: inlineSystem ? undefined : system,
      prompt: inlineSystem ? `${system}\n\n${prompt}` : prompt
    } as any);

    return memorySchema.parse(result.object ?? {}).facts;
  }

  async decideProactive(input: ProactiveDecisionInput): Promise<{
    shouldSpeak: boolean;
    reason: string;
    message?: string;
  }> {
    const config = this.getConfig();
    const resolved = this.getModel(config.modelRouting.chat, "chat");
    const inlineSystem = resolved.providerKind === "custom-openai";
    const system =
      "你是一个克制的陪伴助手。只有在有价值时才主动开口，避免打扰。若 shouldSpeak=false，不给 message。";
    const prompt = [
      input.characterPrompt,
      `触发原因: ${input.reason}`,
      `活动状态: ${input.activity?.summary ?? "未知"}`,
      `长期记忆:\n${this.formatFacts(input.memoryFacts)}`,
      `最近对话:\n${this.formatHistory(input.recentHistory)}`
    ].join("\n\n");

    const result = await generateObject({
      model: resolved.model,
      schema: proactiveSchema,
      system: inlineSystem ? undefined : system,
      prompt: inlineSystem ? `${system}\n\n${prompt}` : prompt
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

      return {
        model: createOpenAI({
          apiKey: provider.apiKey,
          baseURL: provider.baseUrl
        }).chat(model),
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
}
