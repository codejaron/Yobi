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

const proactiveQuietHoursSchema = z
  .object({
    enabled: z.boolean().default(true),
    startMinuteOfDay: z.number().int().min(0).max(1439).default(60),
    endMinuteOfDay: z.number().int().min(0).max(1439).default(420)
  })
  .strict()
  .refine((value) => value.startMinuteOfDay !== value.endMinuteOfDay, {
    path: ["endMinuteOfDay"],
    message: "quiet hours start/end cannot be the same"
  });

const browseAuthStateSchema = z.enum(["missing", "pending", "active", "expired", "error"]);

const kernelTickSchema = z
  .object({
    activeIntervalMs: z.number().int().min(1000).default(5000),
    warmIntervalMs: z.number().int().min(1000).default(30000),
    idleIntervalMs: z.number().int().min(1000).default(3 * 60_000),
    quietIntervalMs: z.number().int().min(1000).default(10 * 60_000)
  })
  .strict();

const kernelBufferSchema = z
  .object({
    maxMessages: z.number().int().min(20).max(1000).default(200),
    lowWatermark: z.number().int().min(10).max(999).default(140)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.lowWatermark >= value.maxMessages) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lowWatermark"],
        message: "lowWatermark must be less than maxMessages"
      });
    }
  });

const kernelRelationshipSchema = z
  .object({
    upgradeWindowDays: z.number().int().min(1).max(30).default(3),
    downgradeWindowDays: z.number().int().min(1).max(90).default(7)
  })
  .strict();

const kernelQueueSchema = z
  .object({
    maxConcurrent: z.number().int().min(1).max(8).default(1),
    retryLimit: z.number().int().min(0).max(8).default(2)
  })
  .strict();

const kernelFactExtractionSchema = z
  .object({
    maxInputTokens: z.number().int().min(256).max(16000).default(3000),
    maxOutputTokens: z.number().int().min(128).max(4000).default(800)
  })
  .strict();

const kernelSchema = z
  .object({
    enabled: z.boolean().default(true),
    tick: kernelTickSchema.default({
      activeIntervalMs: 5000,
      warmIntervalMs: 30000,
      idleIntervalMs: 3 * 60_000,
      quietIntervalMs: 10 * 60_000
    }),
    buffer: kernelBufferSchema.default({
      maxMessages: 200,
      lowWatermark: 140
    }),
    relationship: kernelRelationshipSchema.default({
      upgradeWindowDays: 3,
      downgradeWindowDays: 7
    }),
    queue: kernelQueueSchema.default({
      maxConcurrent: 1,
      retryLimit: 2
    }),
    factExtraction: kernelFactExtractionSchema.default({
      maxInputTokens: 3000,
      maxOutputTokens: 800
    }),
    sessionReentryGapHours: z.number().int().min(1).max(168).default(6),
    dailyTaskHour: z.number().int().min(0).max(23).default(3)
  })
  .strict();

export const appConfigSchema = z
  .object({
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
        chat: modelRouteSchema,
        factExtraction: modelRouteSchema.optional(),
        reflection: modelRouteSchema.optional()
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
        silenceThresholdMs: z.number().int().min(60_000).default(40 * 60 * 1000),
        quietHours: proactiveQuietHoursSchema.default({
          enabled: true,
          startMinuteOfDay: 60,
          endMinuteOfDay: 420
        })
      })
      .strict(),
    browse: z
      .object({
        enabled: z.boolean().default(false),
        bilibiliCookie: z.string().default(""),
        collectIntervalMs: z.number().int().min(60_000).default(30 * 60 * 1000),
        digestIntervalMs: z.number().int().min(60_000).default(2 * 60 * 60 * 1000),
        eventCheckIntervalMs: z.number().int().min(60_000).default(10 * 60 * 1000),
        eventFreshWindowMs: z.number().int().min(60_000).default(2 * 60 * 60 * 1000),
        eventMinGapMs: z.number().int().min(60_000).default(15 * 60 * 1000),
        eventDailyCap: z.number().int().min(1).max(20).default(2),
        tokenBudgetDaily: z.number().int().min(100).default(15_000),
        reversePromptEvery: z.number().int().min(2).max(10).default(4)
      })
      .strict(),
    memory: z
      .object({
        recentMessages: z.number().int().min(10).max(400).default(60)
      })
      .strict(),
    kernel: kernelSchema.default({
      enabled: true,
      tick: {
        activeIntervalMs: 5000,
        warmIntervalMs: 30000,
        idleIntervalMs: 3 * 60_000,
        quietIntervalMs: 10 * 60_000
      },
      buffer: {
        maxMessages: 200,
        lowWatermark: 140
      },
      relationship: {
        upgradeWindowDays: 3,
        downgradeWindowDays: 7
      },
      queue: {
        maxConcurrent: 1,
        retryLimit: 2
      },
      factExtraction: {
        maxInputTokens: 3000,
        maxOutputTokens: 800
      },
      sessionReentryGapHours: 6,
      dailyTaskHour: 3
    }),
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
export type BrowseAuthState = z.infer<typeof browseAuthStateSchema>;

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
      source: "claw" | "yobi";
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

export type ClawTaskStatus = "idle" | "running" | "error";

export interface ClawTaskSessionItem {
  sessionKey: string;
  displayName: string;
  status: ClawTaskStatus;
  activeRunCount: number;
  updatedAt: string;
  lastError?: string;
  lastTransitionAt: string;
}

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
      type: "task-monitor";
      sessions: ClawTaskSessionItem[];
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

export interface BrowseTopComment {
  text: string;
  likes: number;
}

export interface BrowseTopicMaterial {
  bvid: string;
  title: string;
  up: string;
  tags: string[];
  plays?: number;
  duration?: string;
  publishedAt?: string;
  desc?: string;
  topComments: BrowseTopComment[];
  url: string;
}

export interface TopicPoolItem {
  id: string;
  text: string;
  source: string;
  createdAt: string;
  expiresAt: string | null;
  used: boolean;
  material?: BrowseTopicMaterial;
}

export interface BrowseStatus {
  authState: BrowseAuthState;
  lastNavCheckAt: string | null;
  lastCollectAt: string | null;
  lastDigestAt: string | null;
  todayTokenUsed: number;
  todayEventShares: number;
  pausedReason: string | null;
}

export type RelationshipStage =
  | "stranger"
  | "acquaintance"
  | "familiar"
  | "close"
  | "intimate";

export interface EmotionalState {
  mood: number;
  energy: number;
  connection: number;
  curiosity: number;
  confidence: number;
  irritation: number;
}

export interface RelationshipState {
  stage: RelationshipStage;
  upgradeStreak: number;
  downgradeStreak: number;
}

export interface KernelStateDocument {
  emotional: EmotionalState;
  relationship: RelationshipState;
  coldStart: boolean;
  sessionReentry?: {
    active: boolean;
    gapHours: number;
    gapLabel: string;
    activatedAt: string;
  } | null;
  updatedAt: string;
}

export type FactCategory =
  | "identity"
  | "preference"
  | "event"
  | "goal"
  | "relationship"
  | "emotion_pattern";

export type FactTtlClass = "permanent" | "stable" | "active" | "session";

export interface Fact {
  id: string;
  entity: string;
  key: string;
  value: string;
  category: FactCategory;
  confidence: number;
  source: string;
  created_at: string;
  updated_at: string;
  ttl_class: FactTtlClass;
  last_accessed_at: string;
  superseded_by: string | null;
  source_range?: string;
}

export interface UserProfile {
  identity: {
    timezone: string | null;
    typical_schedule: string | null;
    language_preference: string;
  };
  communication: {
    avg_message_length: "short" | "medium" | "long";
    emoji_usage: "none" | "occasional" | "frequent";
    humor_receptivity: number;
    advice_receptivity: number;
    emotional_openness: number;
    preferred_comfort_style: string | null;
    catchphrases: string[];
    tone_words: string[];
  };
  patterns: {
    active_hours: string | null;
    chat_frequency: string | null;
    topic_preferences: string[];
    session_style: string | null;
    response_to_proactive: string | null;
  };
  interaction_notes: {
    what_works: string[];
    what_fails: string[];
    sensitive_topics: string[];
    trust_areas: {
      tech: number;
      life_advice: number;
      emotional_support: number;
      entertainment: number;
    };
  };
  pending_confirmations: Array<{
    id: string;
    field: string;
    value: string;
    needs_confirmation: boolean;
    confirmed: boolean;
    created_at: string;
  }>;
  updated_at: string;
}

export interface Episode {
  id: string;
  date: string;
  summary: string;
  emotional_context: {
    user_mood: string;
    yobi_mood: string;
  };
  unresolved: string[];
  significance: number;
  source_ranges: string[];
  updated_at: string;
}

export interface ReflectionProposal {
  id: string;
  created_at: string;
  summary: string;
  evidence: string[];
  scores: {
    specificity: number;
    evidence: number;
    novelty: number;
    usefulness: number;
  };
  risk: "low" | "high";
  requires_review: boolean;
  applied: boolean;
}

export type PendingTaskType =
  | "fact-extraction"
  | "profile-semantic-update"
  | "daily-episode"
  | "daily-reflection";

export type PendingTaskStatus = "pending" | "running" | "completed" | "failed";

export interface PendingTask {
  id: string;
  type: PendingTaskType;
  status: PendingTaskStatus;
  payload: Record<string, unknown>;
  source_range?: string;
  attempts: number;
  created_at: string;
  updated_at: string;
  last_error?: string;
}

export interface BufferMessage {
  id: string;
  ts: string;
  role: ChatRole;
  channel: "telegram" | "console" | "qq";
  text: string;
  meta?: Record<string, unknown>;
  extracted?: boolean;
}

export interface MindSnapshot {
  soul: string;
  persona: string;
  state: KernelStateDocument;
  profile: UserProfile;
  recentFacts: Fact[];
  recentEpisodes: Episode[];
}

export const TOKEN_USAGE_SOURCES = [
  "chat:console",
  "chat:telegram",
  "chat:qq",
  "browse:bilibili-interest",
  "background:fact-extraction",
  "background:reflection"
] as const;

export type TokenUsageSource = (typeof TOKEN_USAGE_SOURCES)[number];

export interface TokenSourceCounters {
  tokens: number;
  estimatedTokens: number;
}

export interface TokenBucketSummary {
  dayKey: string;
  timeZone: string;
  tzOffsetMinutes: number;
  totalTokens: number;
  estimatedTokens: number;
  bySource: Partial<Record<TokenUsageSource, TokenSourceCounters>>;
  updatedAt: string;
}

export interface TokenStatsStatus {
  retentionDays: number;
  lastUpdatedAt: string | null;
  days: TokenBucketSummary[];
  integrations: {
    claw: "pending" | "ready";
  };
}

export interface KernelStatus {
  enabled: boolean;
  tickIntervalMs: number;
  queueDepth: number;
  lastTickAt: string | null;
  stage: RelationshipStage;
  coldStart: boolean;
}

export const DEFAULT_TOKEN_STATS_STATUS: TokenStatsStatus = {
  retentionDays: 90,
  lastUpdatedAt: null,
  days: [],
  integrations: {
    claw: "pending"
  }
};

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
  browseStatus: BrowseStatus;
  tokenStats: TokenStatsStatus;
  systemPermissions: SystemPermissionStatus;
  kernel?: KernelStatus;
}

export interface InterestProfile {
  games: string[];
  creators: string[];
  domains: string[];
  dislikes: string[];
  keywords: string[];
  updatedAt: string;
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

export const DEFAULT_EMOTIONAL_STATE: EmotionalState = {
  mood: 0,
  energy: 0.6,
  connection: 0.5,
  curiosity: 0.5,
  confidence: 0.5,
  irritation: 0.1
};

export const DEFAULT_KERNEL_STATE: KernelStateDocument = {
  emotional: {
    ...DEFAULT_EMOTIONAL_STATE
  },
  relationship: {
    stage: "stranger",
    upgradeStreak: 0,
    downgradeStreak: 0
  },
  coldStart: true,
  sessionReentry: null,
  updatedAt: new Date(0).toISOString()
};

export const DEFAULT_USER_PROFILE: UserProfile = {
  identity: {
    timezone: null,
    typical_schedule: null,
    language_preference: "zh-CN"
  },
  communication: {
    avg_message_length: "medium",
    emoji_usage: "none",
    humor_receptivity: 0.5,
    advice_receptivity: 0.5,
    emotional_openness: 0.5,
    preferred_comfort_style: null,
    catchphrases: [],
    tone_words: []
  },
  patterns: {
    active_hours: null,
    chat_frequency: null,
    topic_preferences: [],
    session_style: null,
    response_to_proactive: null
  },
  interaction_notes: {
    what_works: [],
    what_fails: [],
    sensitive_topics: [],
    trust_areas: {
      tech: 0.5,
      life_advice: 0.5,
      emotional_support: 0.5,
      entertainment: 0.5
    }
  },
  pending_confirmations: [],
  updated_at: new Date(0).toISOString()
};

export const DEFAULT_CONFIG: AppConfig = {
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
    },
    factExtraction: {
      providerId: "anthropic-main",
      model: "claude-3-5-haiku-latest"
    },
    reflection: {
      providerId: "anthropic-main",
      model: "claude-3-5-haiku-latest"
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
    silenceThresholdMs: 40 * 60 * 1000,
    quietHours: {
      enabled: true,
      startMinuteOfDay: 60,
      endMinuteOfDay: 420
    }
  },
  browse: {
    enabled: false,
    bilibiliCookie: "",
    collectIntervalMs: 30 * 60 * 1000,
    digestIntervalMs: 2 * 60 * 60 * 1000,
    eventCheckIntervalMs: 10 * 60 * 1000,
    eventFreshWindowMs: 2 * 60 * 60 * 1000,
    eventMinGapMs: 15 * 60 * 1000,
    eventDailyCap: 2,
    tokenBudgetDaily: 15_000,
    reversePromptEvery: 4
  },
  memory: {
    recentMessages: 60
  },
  kernel: {
    enabled: true,
    tick: {
      activeIntervalMs: 5000,
      warmIntervalMs: 30000,
      idleIntervalMs: 3 * 60_000,
      quietIntervalMs: 10 * 60_000
    },
    buffer: {
      maxMessages: 200,
      lowWatermark: 140
    },
    relationship: {
      upgradeWindowDays: 3,
      downgradeWindowDays: 7
    },
    queue: {
      maxConcurrent: 1,
      retryLimit: 2
    },
    factExtraction: {
      maxInputTokens: 3000,
      maxOutputTokens: 800
    },
    sessionReentryGapHours: 6,
    dailyTaskHour: 3
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
