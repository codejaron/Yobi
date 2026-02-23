import { z } from "zod";

export const providerSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["openai", "anthropic", "custom-openai"]),
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
    perception: modelRouteSchema,
    memory: modelRouteSchema
  }),
  perception: z.object({
    enabled: z.boolean().default(true),
    pollIntervalMs: z.number().int().min(1000).default(5000),
    screenshotQuality: z.number().int().min(20).max(100).default(55),
    screenshotMaxWidth: z.number().int().min(640).max(2560).default(1200),
    idlePauseSeconds: z.number().int().min(30).max(3600).default(180)
  }),
  voice: z.object({
    ttsVoice: z.string().default("zh-CN-XiaoxiaoNeural"),
    ttsRate: z.string().default("+0%"),
    ttsPitch: z.string().default("+0Hz"),
    proxy: z.string().default(""),
    requestTimeoutMs: z.number().int().min(3000).max(30000).default(15000),
    retryCount: z.number().int().min(0).max(2).default(1)
  }),
  background: z.object({
    keepAwake: z.boolean().default(true)
  }),
  pet: z.object({
    enabled: z.boolean().default(true),
    modelDir: z.string().default(""),
    alwaysOnTop: z.boolean().default(true)
  }),
  realtimeVoice: z.object({
    enabled: z.boolean().default(false),
    whisperMode: z.enum(["local", "api"]).default("api"),
    autoInterrupt: z.boolean().default(true)
  }),
  proactive: z.object({
    cooldownMs: z.number().int().min(10_000).default(25 * 60 * 1000),
    silenceThresholdMs: z.number().int().min(60_000).default(40 * 60 * 1000),
    comebackGraceMs: z.number().int().min(5_000).default(2 * 60 * 1000)
  }),
  memory: z.object({
    workingSetSize: z.number().int().min(10).max(100).default(30),
    summarizeEveryTurns: z.number().int().min(10).max(500).default(50)
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

export interface HistoryMessage {
  id: string;
  role: ChatRole;
  text: string;
  channel: "telegram" | "system";
  timestamp: string;
  meta?: {
    proactive?: boolean;
    activitySnapshot?: string;
  };
}

export interface ActivitySnapshot {
  app: string;
  title: string;
  summary: string;
  changedAt: string;
}

export interface CharacterProfile {
  id: string;
  name: string;
  systemPrompt: string;
}

export interface RuntimeContext {
  lastWindowKey: string;
  lastActivitySummary: string;
  lastProactiveAt: string | null;
  lastUserAt: string | null;
  eyesCommandEnabled: boolean;
}

export interface AppStatus {
  bootedAt: string;
  telegramConnected: boolean;
  lastActivitySummary: string;
  lastUserAt: string | null;
  lastProactiveAt: string | null;
  historyCount: number;
  memoryFacts: number;
  perceptionRunning: boolean;
  keepAwakeActive: boolean;
  pendingReminders: number;
  petOnline: boolean;
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
      apiKey: "",
      enabled: true
    },
    {
      id: "anthropic-main",
      label: "Anthropic",
      kind: "anthropic",
      apiKey: "",
      enabled: true
    }
  ],
  modelRouting: {
    chat: {
      providerId: "anthropic-main",
      model: "claude-sonnet-4"
    },
    perception: {
      providerId: "openai-main",
      model: "gpt-4o-mini"
    },
    memory: {
      providerId: "openai-main",
      model: "gpt-4o-mini"
    }
  },
  perception: {
    enabled: true,
    pollIntervalMs: 5000,
    screenshotQuality: 55,
    screenshotMaxWidth: 1200,
    idlePauseSeconds: 180
  },
  voice: {
    ttsVoice: "zh-CN-XiaoxiaoNeural",
    ttsRate: "+0%",
    ttsPitch: "+0Hz",
    proxy: "",
    requestTimeoutMs: 15000,
    retryCount: 1
  },
  background: {
    keepAwake: true
  },
  pet: {
    enabled: true,
    modelDir: "",
    alwaysOnTop: true
  },
  realtimeVoice: {
    enabled: false,
    whisperMode: "api",
    autoInterrupt: true
  },
  proactive: {
    cooldownMs: 25 * 60 * 1000,
    silenceThresholdMs: 40 * 60 * 1000,
    comebackGraceMs: 2 * 60 * 1000
  },
  memory: {
    workingSetSize: 30,
    summarizeEveryTurns: 50
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
  lastWindowKey: "",
  lastActivitySummary: "",
  lastProactiveAt: null,
  lastUserAt: null,
  eyesCommandEnabled: true
};
