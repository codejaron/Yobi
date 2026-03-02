import { z } from "zod";

export const providerSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum(["openai", "anthropic", "custom-openai", "openrouter"]),
    apiMode: z.enum(["chat", "responses"]).default("chat"),
    apiKey: z.string().default(""),
    baseUrl: z.string().url().optional(),
    enabled: z.boolean().default(true)
  })
  .strict();

export const modelRouteSchema = z
  .object({
    providerId: z.string().min(1),
    model: z.string().min(1)
  })
  .strict();

export const mcpRemoteServerSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    enabled: z.boolean().default(true),
    transport: z.literal("remote"),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).default({})
  })
  .strict();

export const mcpStdioServerSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    enabled: z.boolean().default(true),
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({})
  })
  .strict();

export const mcpServerSchema = z.discriminatedUnion("transport", [
  mcpRemoteServerSchema,
  mcpStdioServerSchema
]);

export const DEFAULT_MCP_SERVERS: Array<z.output<typeof mcpServerSchema>> = [
  {
    id: "exa",
    label: "Exa Search",
    enabled: true,
    transport: "remote",
    url: "https://mcp.exa.ai/mcp",
    headers: {}
  }
] as const;

export const appConfigSchema = z
  .object({
    characterId: z.string().default("default"),
    telegram: z
      .object({
        enabled: z.boolean().default(false),
        botToken: z.string().default(""),
        chatId: z.string().default("")
      })
      .strict(),
    qq: z
      .object({
        enabled: z.boolean().default(false),
        appId: z.string().default(""),
        appSecret: z.string().default("")
      })
      .strict(),
    messaging: z
      .object({
        allowVoiceMessages: z.boolean().default(true),
        allowPhotoInput: z.boolean().default(true)
      })
      .strict(),
    providers: z.array(providerSchema),
    modelRouting: z
      .object({
        chat: modelRouteSchema
      })
      .strict(),
    voice: z
      .object({
        ttsVoice: z.string().default("zh-CN-XiaoxiaoNeural"),
        ttsRate: z.string().default("+0%"),
        ttsPitch: z.string().default("+0Hz"),
        requestTimeoutMs: z.number().int().min(3000).max(30000).default(15000),
        retryCount: z.number().int().min(0).max(2).default(1)
      })
      .strict(),
    alibabaVoice: z
      .object({
        enabled: z.boolean().default(false),
        apiKey: z.string().default(""),
        region: z.enum(["cn", "intl"]).default("cn"),
        asrModel: z.string().default("fun-asr-realtime"),
        ttsModel: z.string().default("cosyvoice-v3-flash"),
        ttsVoice: z.string().default("longxiaochun_v3")
      })
      .strict(),
    background: z
      .object({
        keepAwake: z.boolean().default(true)
      })
      .strict(),
    pet: z
      .object({
        enabled: z.boolean().default(false),
        modelDir: z.string().default(""),
        alwaysOnTop: z.boolean().default(true)
      })
      .strict(),
    ptt: z
      .object({
        enabled: z.boolean().default(true),
        hotkey: z.string().default("Alt+Space")
      })
      .strict(),
    realtimeVoice: z
      .object({
        enabled: z.boolean().default(false),
        whisperMode: z.enum(["local", "api"]).default("api"),
        autoInterrupt: z.boolean().default(true)
      })
      .strict(),
    proactive: z
      .object({
        enabled: z.boolean().default(false),
        localOnly: z.boolean().default(true),
        cooldownMs: z.number().int().min(10_000).default(25 * 60 * 1000),
        silenceThresholdMs: z.number().int().min(60_000).default(40 * 60 * 1000)
      })
      .strict(),
    memory: z
      .object({
        recentMessages: z.number().int().min(10).max(200).default(40),
        observational: z
          .object({
            enabled: z.boolean().default(false),
            providerId: z.string().default(""),
            model: z.string().default("")
          })
          .strict()
      })
      .strict(),
    openclaw: z
      .object({
        enabled: z.boolean().default(false),
        gatewayUrl: z.string().url().default("http://127.0.0.1:18789"),
        approvalRequired: z.boolean().default(true),
        modelPrimary: z.string().default(""),
        modelFallbacks: z.array(z.string().min(1)).default([]),
        thinkingDefault: z
          .enum(["off", "low", "medium", "high", "xhigh", "minimal"])
          .default("low"),
        contextTokens: z.number().int().min(1).max(2_000_000).default(200_000),
        timeoutSeconds: z.number().int().min(30).max(7_200).default(600),
        browserEnabled: z.boolean().default(true),
        browserProfile: z.enum(["openclaw", "chrome"]).default("openclaw"),
        browserHeadless: z.boolean().default(false),
        browserExecutablePath: z.string().default(""),
        heartbeatEvery: z.string().default("30m"),
        toolWebSearchEnabled: z.boolean().default(true),
        toolWebFetchEnabled: z.boolean().default(true),
        toolExecEnabled: z.boolean().default(true),
        toolElevatedEnabled: z.boolean().default(false),
        maxConcurrent: z.number().int().min(1).max(32).default(1),
        sandboxMode: z.enum(["off", "non-main", "all"]).default("non-main")
      })
      .strict(),
    tools: z
      .object({
        mcp: z
          .object({
            servers: z.array(mcpServerSchema).default(DEFAULT_MCP_SERVERS)
          })
          .strict()
      })
      .strict()
  })
  .strict();

export type ProviderConfig = z.infer<typeof providerSchema>;
export type ModelRoute = z.infer<typeof modelRouteSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;

export type ChatRole = "system" | "user" | "assistant";

export type CommandApprovalDecision = "allow-once" | "allow-always" | "deny";

export type ConsoleRunEventV2 =
  | {
      requestId: string;
      type: "thinking";
      state: "start" | "stop";
      timestamp: string;
    }
  | {
      requestId: string;
      type: "text-delta";
      delta: string;
      timestamp: string;
    }
  | {
      requestId: string;
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: unknown;
      timestamp: string;
    }
  | {
      requestId: string;
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      input: unknown;
      output?: unknown;
      error?: string;
      success: boolean;
      timestamp: string;
    }
  | {
      requestId: string;
      type: "approval-request";
      approvalId: string;
      toolName: string;
      description: string;
      timestamp: string;
    }
  | {
      requestId: string;
      type: "approval-decision";
      approvalId: string;
      decision: CommandApprovalDecision;
      timestamp: string;
    }
  | {
      requestId: string;
      type: "final";
      rawText: string;
      displayText: string;
      timestamp: string;
    }
  | {
      requestId: string;
      type: "error";
      message: string;
      timestamp: string;
    }
  | {
      requestId: string;
      type: "external-assistant-message";
      messageId: string;
      text: string;
      source: "claw";
      timestamp: string;
    };

export type ClawOrigin = "yobi-tool" | "claw-tab" | "unknown";

export interface ClawHistoryItem {
  id: string;
  role: "assistant" | "user" | "system" | "tool";
  text: string;
  timestamp?: string;
}

export type ClawConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected-manual";

export type ClawEvent =
  | {
      type: "connection";
      state: ClawConnectionState;
      message: string;
      timestamp: string;
    }
  | {
      type: "user-message";
      sessionKey: string;
      text: string;
      origin: ClawOrigin;
      timestamp: string;
    }
  | {
      type: "status";
      sessionKey: string;
      message: string;
      timestamp: string;
    }
  | {
      type: "assistant-delta";
      sessionKey: string;
      delta: string;
      timestamp: string;
    }
  | {
      type: "assistant-final";
      sessionKey: string;
      text: string;
      origin: ClawOrigin;
      timestamp: string;
    }
  | {
      type: "tool";
      sessionKey: string;
      phase: "start" | "result" | "error";
      toolName: string;
      input?: unknown;
      output?: unknown;
      error?: string;
      timestamp: string;
    }
  | {
      type: "lifecycle";
      sessionKey: string;
      status: string;
      detail?: string;
      timestamp: string;
    }
  | {
      type: "history";
      sessionKey: string;
      items: ClawHistoryItem[];
      timestamp: string;
    }
  | {
      type: "error";
      sessionKey?: string;
      message: string;
      code?: string;
      timestamp: string;
    };

export interface HistoryMessage {
  id: string;
  role: ChatRole;
  text: string;
  channel: "telegram" | "console" | "qq";
  timestamp: string;
  meta?: {
    proactive?: boolean;
    source?: "claw" | "yobi";
  };
}

export interface CharacterProfile {
  id: string;
  name: string;
  systemPrompt: string;
  workingMemoryTemplate?: string;
}

export interface RuntimeContext {
  lastProactiveAt: string | null;
  lastUserAt: string | null;
}

export type PermissionState = "granted" | "denied" | "unknown";

export interface SystemPermissionStatus {
  accessibility: PermissionState;
  microphone: PermissionState;
  screenCapture: PermissionState;
}

export interface TopicPoolItem {
  id: string;
  text: string;
  source: string;
  createdAt: string;
  expiresAt: string | null;
  used: boolean;
}

export interface AppStatus {
  bootedAt: string;
  telegramConnected: boolean;
  qqConnected: boolean;
  lastUserAt: string | null;
  lastProactiveAt: string | null;
  historyCount: number;
  keepAwakeActive: boolean;
  topicPool: TopicPoolItem[];
  petOnline: boolean;
  openclawOnline: boolean;
  openclawStatus: string;
  systemPermissions: SystemPermissionStatus;
}

export interface ReminderItem {
  id: string;
  text: string;
  at: string;
  createdAt: string;
  sourceMessageId?: string;
}

export interface ReminderDocument {
  items: ReminderItem[];
}

export interface WorkingMemoryDocument {
  markdown: string;
  updatedAt: string;
}

export const DEFAULT_WORKING_MEMORY_TEMPLATE = `# 用户
- 称呼：（用户希望被叫什么）
- 基本情况：（职业、年龄段、生活状态等已知信息）
- 性格印象：（通过对话观察到的性格特点）

# 兴趣与偏好
- 感兴趣的领域：（技术/游戏/音乐/读书/其他）
- 近期关注的事：（最近在做什么项目、在追什么、在忙什么）
- 交流偏好：（喜欢长聊还是简短、能接受吐槽的程度、喜欢什么语气风格）

# 重要记忆
（记录具体的事件，不要泛泛概括。格式：发生了什么 + 用户的反应/感受）

# 待跟进
（用户提到过但还没有后续的事情，比如“下周要面试”、“最近想学 Rust”、“胃不舒服”。跟进后移除或更新。）

# 关系
- 阶段：初识 / 渐渐熟悉 / 老朋友 / 很亲近
- 里程碑：（第一次深聊、第一次闹别扭、第一次用户主动找你聊心事，等等）
- 当前氛围：（最近几次交流的整体感觉——轻松/正常/有点疏远/很亲密）

# Yobi 自身
- 当前情绪：（基于最近对话的情绪倾向——平静/开心/有点无聊/小委屈/好奇）
- 最近在想的：（Yobi“自己”想聊的话题或想分享的东西）
- 对用户的小观察：（注意到但还没说出口的事情——比如“用户最近回复越来越慢了，不知道是不是很忙”）

# 当前对话
- 今天聊的主线：（这次对话的核心话题）
- 走向：（是在深入探讨 / 闲聊发散 / 快要聊完了）
- 还没展开的点：（用户随口提了但没细聊的东西，可以后续找机会提起）`;

export const DEFAULT_CONFIG: AppConfig = {
  characterId: "default",
  telegram: {
    enabled: false,
    botToken: "",
    chatId: ""
  },
  qq: {
    enabled: false,
    appId: "",
    appSecret: ""
  },
  messaging: {
    allowVoiceMessages: true,
    allowPhotoInput: true
  },
  providers: [
    {
      id: "openai-main",
      label: "OpenAI",
      kind: "openai",
      apiMode: "chat",
      apiKey: "",
      enabled: true
    },
    {
      id: "anthropic-main",
      label: "Anthropic",
      kind: "anthropic",
      apiMode: "chat",
      apiKey: "",
      enabled: true
    }
  ],
  modelRouting: {
    chat: {
      providerId: "anthropic-main",
      model: "claude-sonnet-4"
    }
  },
  voice: {
    ttsVoice: "zh-CN-XiaoxiaoNeural",
    ttsRate: "+0%",
    ttsPitch: "+0Hz",
    requestTimeoutMs: 15000,
    retryCount: 1
  },
  alibabaVoice: {
    enabled: false,
    apiKey: "",
    region: "cn",
    asrModel: "fun-asr-realtime",
    ttsModel: "cosyvoice-v3-flash",
    ttsVoice: "longxiaochun_v3"
  },
  background: {
    keepAwake: true
  },
  pet: {
    enabled: false,
    modelDir: "",
    alwaysOnTop: true
  },
  ptt: {
    enabled: true,
    hotkey: "Alt+Space"
  },
  realtimeVoice: {
    enabled: false,
    whisperMode: "api",
    autoInterrupt: true
  },
  proactive: {
    enabled: false,
    localOnly: true,
    cooldownMs: 25 * 60 * 1000,
    silenceThresholdMs: 40 * 60 * 1000
  },
  memory: {
    recentMessages: 40,
    observational: {
      enabled: false,
      providerId: "",
      model: ""
    }
  },
  openclaw: {
    enabled: false,
    gatewayUrl: "http://127.0.0.1:18789",
    approvalRequired: true,
    modelPrimary: "",
    modelFallbacks: [],
    thinkingDefault: "low",
    contextTokens: 200_000,
    timeoutSeconds: 600,
    browserEnabled: true,
    browserProfile: "openclaw",
    browserHeadless: false,
    browserExecutablePath: "",
    heartbeatEvery: "30m",
    toolWebSearchEnabled: true,
    toolWebFetchEnabled: true,
    toolExecEnabled: true,
    toolElevatedEnabled: false,
    maxConcurrent: 1,
    sandboxMode: "non-main"
  },
  tools: {
    mcp: {
      servers: DEFAULT_MCP_SERVERS.map((server) =>
        server.transport === "stdio"
          ? {
              ...server,
              args: [...server.args],
              env: {
                ...server.env
              }
            }
          : {
              ...server,
              headers: {
                ...server.headers
              }
            }
      )
    }
  }
};

export const DEFAULT_REMINDERS: ReminderDocument = {
  items: []
};

export const DEFAULT_CONTEXT: RuntimeContext = {
  lastProactiveAt: null,
  lastUserAt: null
};
