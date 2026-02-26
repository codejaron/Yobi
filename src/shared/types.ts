import { z } from "zod";

export const providerSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["openai", "anthropic", "custom-openai", "openrouter"]),
  apiMode: z.enum(["chat", "responses"]).default("chat"),
  apiKey: z.string().default(""),
  baseUrl: z.string().url().optional(),
  enabled: z.boolean().default(true)
});

export const modelRouteSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1)
});

export const appConfigSchema = z.object({
  characterId: z.string().default("default"),
  telegram: z.object({
    botToken: z.string().default(""),
    chatId: z.string().default("")
  }),
  messaging: z.object({
    allowVoiceMessages: z.boolean().default(true),
    allowPhotoInput: z.boolean().default(true)
  }),
  providers: z.array(providerSchema),
  modelRouting: z.object({
    chat: modelRouteSchema,
    memory: modelRouteSchema
  }),
  voice: z.object({
    ttsVoice: z.string().default("zh-CN-XiaoxiaoNeural"),
    ttsRate: z.string().default("+0%"),
    ttsPitch: z.string().default("+0Hz"),
    requestTimeoutMs: z.number().int().min(3000).max(30000).default(15000),
    retryCount: z.number().int().min(0).max(2).default(1)
  }),
  alibabaVoice: z.object({
    enabled: z.boolean().default(false),
    apiKey: z.string().default(""),
    region: z.enum(["cn", "intl"]).default("cn"),
    asrModel: z.string().default("fun-asr-realtime"),
    ttsModel: z.string().default("cosyvoice-v3-flash"),
    ttsVoice: z.string().default("longxiaochun_v3")
  }),
  background: z.object({
    keepAwake: z.boolean().default(true)
  }),
  pet: z.object({
    enabled: z.boolean().default(true),
    modelDir: z.string().default(""),
    alwaysOnTop: z.boolean().default(true)
  }),
  ptt: z.object({
    enabled: z.boolean().default(true),
    hotkey: z.string().default("Alt+Space")
  }),
  realtimeVoice: z.object({
    enabled: z.boolean().default(false),
    whisperMode: z.enum(["local", "api"]).default("api"),
    autoInterrupt: z.boolean().default(true)
  }),
  proactive: z.object({
    enabled: z.boolean().default(false),
    pushToTelegram: z.boolean().default(false),
    cooldownMs: z.number().int().min(10_000).default(25 * 60 * 1000),
    silenceThresholdMs: z.number().int().min(60_000).default(40 * 60 * 1000)
  }),
  memory: z.object({
    workingSetSize: z.number().int().min(10).max(100).default(30),
    summarizeEveryTurns: z.number().int().min(10).max(500).default(50)
  }),
  tools: z.object({
    browser: z.object({
      enabled: z.boolean().default(false),
      headless: z.boolean().default(false),
      cdpPort: z.number().int().min(1000).max(65535).default(19222),
      allowedDomains: z.array(z.string().min(1)).default([]),
      blockPrivateNetwork: z.boolean().default(true)
    }),
    system: z.object({
      enabled: z.boolean().default(false),
      execEnabled: z.boolean().default(false),
      allowedCommands: z.array(z.string().min(1)).default([]),
      blockedPatterns: z.array(z.string().min(1)).default(["rm -rf", "sudo"]),
      approvalRequired: z.boolean().default(true)
    }),
    file: z.object({
      readEnabled: z.boolean().default(true),
      writeEnabled: z.boolean().default(false),
      allowedPaths: z.array(z.string().min(1)).default([])
    })
  })
});

export const memoryFactSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  confidence: z.number().min(0).max(1).default(0.5),
  updatedAt: z.string().datetime()
});

export const memoryDocumentSchema = z.object({
  facts: z.array(memoryFactSchema).default([]),
  lastSummarizedAt: z.string().datetime().nullable().default(null),
  turnsSinceSummary: z.number().int().min(0).default(0)
});

export type ProviderConfig = z.infer<typeof providerSchema>;
export type ModelRoute = z.infer<typeof modelRouteSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;
export type MemoryFact = z.infer<typeof memoryFactSchema>;
export type MemoryDocument = z.infer<typeof memoryDocumentSchema>;

export type ChatRole = "system" | "user" | "assistant";

export type CommandApprovalDecision = "allow-once" | "allow-always" | "deny";

export type ConsoleChatEvent =
  | {
      requestId: string;
      type: "thinking";
      state: "start" | "stop";
      timestamp: string;
    }
  | {
      requestId: string;
      type: "reasoning-delta";
      delta: string;
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
    };

export interface HistoryMessage {
  id: string;
  role: ChatRole;
  text: string;
  channel: "telegram" | "system";
  timestamp: string;
  meta?: {
    proactive?: boolean;
  };
}

export interface CharacterProfile {
  id: string;
  name: string;
  systemPrompt: string;
}

export interface RuntimeContext {
  lastProactiveAt: string | null;
  lastUserAt: string | null;
}

export interface AppStatus {
  bootedAt: string;
  telegramConnected: boolean;
  lastUserAt: string | null;
  lastProactiveAt: string | null;
  historyCount: number;
  memoryFacts: number;
  keepAwakeActive: boolean;
  pendingReminders: number;
  petOnline: boolean;
  macAccessibilityPermission: "granted" | "denied" | "unknown";
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

export interface AssistantOutputParseResult {
  visibleText: string;
  voiceTexts: string[];
  reminders: Array<{
    time: string;
    text: string;
  }>;
  emotions: string[];
}

export const DEFAULT_CONFIG: AppConfig = {
  characterId: "default",
  telegram: {
    botToken: "",
    chatId: ""
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
    },
    memory: {
      providerId: "openai-main",
      model: "gpt-4o-mini"
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
    enabled: true,
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
    pushToTelegram: false,
    cooldownMs: 25 * 60 * 1000,
    silenceThresholdMs: 40 * 60 * 1000
  },
  memory: {
    workingSetSize: 30,
    summarizeEveryTurns: 50
  },
  tools: {
    browser: {
      enabled: false,
      headless: false,
      cdpPort: 19222,
      allowedDomains: [],
      blockPrivateNetwork: true
    },
    system: {
      enabled: false,
      execEnabled: false,
      allowedCommands: [],
      blockedPatterns: ["rm -rf", "sudo"],
      approvalRequired: true
    },
    file: {
      readEnabled: true,
      writeEnabled: false,
      allowedPaths: []
    }
  }
};

export const DEFAULT_MEMORY: MemoryDocument = {
  facts: [],
  lastSummarizedAt: null,
  turnsSinceSummary: 0
};

export const DEFAULT_REMINDERS: ReminderDocument = {
  items: []
};

export const DEFAULT_CONTEXT: RuntimeContext = {
  lastProactiveAt: null,
  lastUserAt: null
};
