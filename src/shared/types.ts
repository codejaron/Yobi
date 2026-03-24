import { z } from "zod";
import {
  PROVIDER_API_MODES,
  PROVIDER_KINDS,
  QWEN_REGIONS
} from "./provider-catalog";
import { MEMORY_RUNTIME_DEFAULTS } from "./runtime-tuning";

export const providerSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum(PROVIDER_KINDS),
    apiMode: z.enum(PROVIDER_API_MODES).default("chat"),
    apiKey: z.string().default(""),
    baseUrl: z.string().url().optional(),
    qwenRegion: z.enum(QWEN_REGIONS).optional(),
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

export const DEFAULT_MCP_SERVERS: Array<z.output<typeof mcpServerSchema>> = [];

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

const proactivePushTargetsSchema = z
  .object({
    telegram: z.boolean().default(false),
    feishu: z.boolean().default(false)
  })
  .strict();

export const scheduledTaskPushTargetsSchema = proactivePushTargetsSchema;

export const scheduledTaskToolNameSchema = z.enum([
  "browser",
  "system",
  "file",
  "web_search",
  "code_search",
  "web_fetch"
]);

export const scheduledTaskTriggerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("once"),
      runAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, "执行时间必须是本地时间格式 YYYY-MM-DDTHH:mm[:ss]")
    })
    .strict(),
  z
    .object({
      kind: z.literal("cron"),
      expression: z.string().min(1),
      timezone: z.literal("local").default("local")
    })
    .strict()
]);

export const scheduledTaskActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("notify"),
      text: z.string().min(1),
      pushTargets: scheduledTaskPushTargetsSchema.optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent"),
      prompt: z.string().min(1),
      pushTargets: scheduledTaskPushTargetsSchema.optional(),
      allowedTools: z.array(scheduledTaskToolNameSchema).default([])
    })
    .strict()
]);

export const scheduledTaskStatusSchema = z.enum([
  "enabled",
  "paused",
  "completed",
  "failed",
  "missed"
]);

export const scheduledTaskRunStatusSchema = z.enum([
  "success",
  "failed",
  "missed",
  "skipped"
]);

export const themeModeSchema = z.enum(["system", "light", "dark"]);
export const realtimeVoiceModeSchema = z.enum(["ptt", "free"]);
export const realtimeVoiceFirstChunkStrategySchema = z.enum(["aggressive", "balanced"]);
export const senseVoiceLocalModelNameSchema = z.enum(["SenseVoiceSmall-int8"]);

export const scheduledTaskSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    trigger: scheduledTaskTriggerSchema,
    action: scheduledTaskActionSchema,
    status: scheduledTaskStatusSchema,
    nextRunAt: z.string().nullable(),
    lastRunAt: z.string().datetime().nullable(),
    lastRunStatus: scheduledTaskRunStatusSchema.nullable(),
    lastRunMessage: z.string().nullable(),
    pauseReason: z.string().nullable(),
    consecutiveFailures: z.number().int().min(0),
    approvalRequiredAtCreation: z.boolean().default(false),
    approvalSignature: z.string().nullable(),
    approvedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();

export const scheduledTaskRunSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    taskName: z.string().min(1),
    status: scheduledTaskRunStatusSchema,
    scheduledFor: z.string().nullable(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    message: z.string().nullable(),
    error: z.string().nullable()
  })
  .strict();

export const scheduledTaskInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    trigger: scheduledTaskTriggerSchema,
    action: scheduledTaskActionSchema,
    enabled: z.boolean().optional()
  })
  .strict();

const browseAuthStateSchema = z.enum(["missing", "pending", "active", "expired", "error"]);

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
    feishu: z
      .object({
        enabled: z.boolean().default(false),
        appId: z.string().default(""),
        appSecret: z.string().default("")
      })
      .strict(),
    providers: z.array(providerSchema),
    modelRouting: z
      .object({
        chat: modelRouteSchema,
        reflection: modelRouteSchema,
        cognition: modelRouteSchema
      })
      .strict(),
    voice: z
      .object({
        asrProvider: z.enum(["none", "sensevoice-local", "alibaba"]).default("none"),
        ttsProvider: z.enum(["edge", "alibaba"]).default("edge"),
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
    senseVoiceLocal: z
      .object({
        enabled: z.boolean().default(false),
        modelName: senseVoiceLocalModelNameSchema.default("SenseVoiceSmall-int8")
      })
      .strict(),
    background: z
      .object({
        keepAwake: z.boolean().default(true)
      })
      .strict(),
    appearance: z
      .object({
        themeMode: themeModeSchema.default("system")
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
        speechReplyEnabled: z.boolean().default(true),
        mode: realtimeVoiceModeSchema.default("ptt"),
        vadThreshold: z.number().min(0).max(1).default(0.5),
        minSpeechMs: z.number().int().min(50).max(10_000).default(180),
        minSilenceMs: z.number().int().min(100).max(10_000).default(600),
        preRollMs: z.number().int().min(0).max(5_000).default(240),
        maxUtteranceMs: z.number().int().min(1_000).max(5 * 60_000).default(45_000),
        firstChunkStrategy: realtimeVoiceFirstChunkStrategySchema.default("aggressive"),
        chunkFlushMs: z.number().int().min(100).max(10_000).default(450),
        autoInterrupt: z.boolean().default(true),
        aecEnabled: z.boolean().default(true),
        playbackCrossfadeMs: z.number().int().min(0).max(1_000).default(80)
      })
      .strict(),
    proactive: z
      .object({
        enabled: z.boolean().default(false),
        pushTargets: proactivePushTargetsSchema.default({
          telegram: false,
          feishu: false
        }),
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
        autoFollowEnabled: z.boolean().default(false)
      })
      .strict(),
    memory: z
      .object({
        recentMessages: z.number().int().min(10).max(400).default(MEMORY_RUNTIME_DEFAULTS.recentMessages),
        embedding: z
          .object({
            enabled: z.boolean().default(true),
            similarityThreshold: z
              .number()
              .min(0)
              .max(1)
              .default(MEMORY_RUNTIME_DEFAULTS.embedding.similarityThreshold)
          })
          .strict()
          .default({
            enabled: true,
            similarityThreshold: MEMORY_RUNTIME_DEFAULTS.embedding.similarityThreshold
          }),
        facts: z
          .object({
            activeSoftCap: z.number().int().min(50).max(5000).default(500)
          })
          .strict()
          .default({
            activeSoftCap: 500
          }),
        retrieval: z
          .object({
            candidateMultiplier: z.number().int().min(1).max(8).default(2),
            vectorWeight: z.number().min(0).max(1).default(0.6),
            textWeight: z.number().min(0).max(1).default(0.4)
          })
          .strict()
          .default({
            candidateMultiplier: 2,
            vectorWeight: 0.6,
            textWeight: 0.4
          })
      })
      .strict(),
    tools: z
      .object({
        browser: z
          .object({
            enabled: z.boolean().default(false),
            headless: z.boolean().default(false),
            cdpPort: z.number().int().min(1000).max(65535).default(19222),
            allowedDomains: z.array(z.string().min(1)).default([]),
            blockPrivateNetwork: z.boolean().default(true)
          })
          .strict(),
        system: z
          .object({
            enabled: z.boolean().default(false),
            execEnabled: z.boolean().default(false),
            allowedCommands: z.array(z.string().min(1)).default([]),
            blockedPatterns: z.array(z.string().min(1)).default(["rm -rf", "sudo"]),
            approvalRequired: z.boolean().default(true)
          })
          .strict(),
        file: z
          .object({
            readEnabled: z.boolean().default(true),
            writeEnabled: z.boolean().default(false),
            allowedPaths: z.array(z.string().min(1)).default([])
          })
          .strict(),
        exa: z
          .object({
            enabled: z.boolean().default(true)
          })
          .strict(),
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
export type ThemeMode = z.infer<typeof themeModeSchema>;
export type ResolvedTheme = Exclude<ThemeMode, "system">;
export type BrowseAuthState = z.infer<typeof browseAuthStateSchema>;
export type ScheduledTaskToolName = z.infer<typeof scheduledTaskToolNameSchema>;
export type ScheduledTaskTrigger = z.infer<typeof scheduledTaskTriggerSchema>;
export type ScheduledTaskAction = z.infer<typeof scheduledTaskActionSchema>;
export type ScheduledTaskStatus = z.infer<typeof scheduledTaskStatusSchema>;
export type ScheduledTaskRunStatus = z.infer<typeof scheduledTaskRunStatusSchema>;
export type ScheduledTask = z.infer<typeof scheduledTaskSchema>;
export type ScheduledTaskRun = z.infer<typeof scheduledTaskRunSchema>;
export type ScheduledTaskInput = z.infer<typeof scheduledTaskInputSchema>;
export type RealtimeVoiceMode = z.infer<typeof realtimeVoiceModeSchema>;
export type RealtimeVoiceFirstChunkStrategy = z.infer<typeof realtimeVoiceFirstChunkStrategySchema>;

export type ChatRole = "system" | "user" | "assistant";
export type CommandApprovalDecision = "allow-once" | "allow-always" | "deny";

export interface SkillCompatibility {
  status: "compatible" | "partial" | "invalid";
  issues: string[];
}

export interface SkillResourceEntry {
  kind: "script" | "reference" | "asset" | "template";
  relativePath: string;
}

export interface SkillCatalogItem {
  id: string;
  name: string;
  description: string;
  version: string | null;
  tags: string[];
  enabled: boolean;
  directoryPath: string;
  markdownPath: string;
  compatibility: SkillCompatibility;
  resourceEntries: SkillResourceEntry[];
  metadata: Record<string, unknown>;
  markdownPreview: string | null;
}

export interface SkillsCatalogSummary {
  enabledCount: number;
  truncated: boolean;
  truncatedDescriptions: number;
  omittedSkills: number;
}

export interface SkillActivatedEventPayload {
  skillId: string;
  name: string;
  compatibility: SkillCompatibility;
}

export type ToolTraceStatus = "success" | "error" | "aborted";

export interface ToolTraceItem {
  toolName: string;
  status: ToolTraceStatus;
  inputPreview: string;
  durationMs?: number;
}

export interface AssistantTimelineTextBlock {
  type: "text";
  text: string;
}

export interface AssistantTimelineToolBlock {
  type: "tool";
  tool: ToolTraceItem;
}

export type AssistantTimelineBlock =
  | AssistantTimelineTextBlock
  | AssistantTimelineToolBlock;

export type VoiceSessionPhase =
  | "idle"
  | "listening"
  | "user-speaking"
  | "transcribing"
  | "assistant-thinking"
  | "assistant-speaking"
  | "interrupted"
  | "error";

export interface VoiceSessionTarget {
  resourceId: string;
  threadId: string;
  source: "console" | "pet" | "voice";
}

export interface VoicePlaybackState {
  active: boolean;
  queueLength: number;
  level: number;
  currentText: string;
}

export interface SpeechRecognitionMetadata {
  language: string | null;
  emotion: string | null;
  event: string | null;
  rawTags: string[];
}

export interface VoiceInputContext {
  provider: AppConfig["voice"]["asrProvider"];
  metadata: SpeechRecognitionMetadata;
}

export interface VoiceTranscriptionResult {
  text: string;
  metadata: SpeechRecognitionMetadata | null;
}

export interface VoiceHistoryMeta {
  source: "voice";
  sessionId: string;
  mode: RealtimeVoiceMode;
  interrupted: boolean;
  playedTextLength: number;
  asrProvider: AppConfig["voice"]["asrProvider"];
  ttsProvider: AppConfig["voice"]["ttsProvider"];
}

export type ChatAttachmentKind = "image" | "file";
export type ChatAttachmentSource = "user-upload" | "tool-generated";

export interface ConsoleChatAttachmentInput {
  name?: string;
  mimeType?: string | null;
  size?: number;
  dataBase64: string;
}

export interface ChatAttachment {
  id: string;
  kind: ChatAttachmentKind;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  source: ChatAttachmentSource;
  createdAt: string;
}

export interface AttachmentReferenceNote {
  attachmentId: string;
  filename: string;
  mimeType: string;
  path: string;
  reason: "expired" | "missing";
}

export interface HistoryMessageMeta {
  proactive?: boolean;
  source?: "yobi";
  toolTrace?: {
    items: ToolTraceItem[];
  };
  assistantTimeline?: {
    blocks: AssistantTimelineBlock[];
  };
  voice?: VoiceHistoryMeta;
  speechRecognition?: VoiceInputContext;
  attachments?: ChatAttachment[];
  attachmentReferences?: AttachmentReferenceNote[];
}

export interface VoiceSessionState {
  sessionId: string | null;
  phase: VoiceSessionPhase;
  mode: RealtimeVoiceMode;
  target: VoiceSessionTarget | null;
  userTranscript: string;
  userTranscriptMetadata: SpeechRecognitionMetadata | null;
  assistantTranscript: string;
  lastInterruptReason: "vad" | "manual" | "system" | null;
  errorMessage: string | null;
  playback: VoicePlaybackState;
  updatedAt: string;
}

export type VoiceSessionCommand =
  | { type: "start"; target?: Partial<VoiceSessionTarget>; mode?: RealtimeVoiceMode }
  | { type: "stop" }
  | { type: "interrupt"; reason?: "vad" | "manual" | "system" }
  | { type: "set-mode"; mode: RealtimeVoiceMode }
  | { type: "ptt"; phase: "down" | "up" };

export type VoiceSessionEvent =
  | {
      type: "state";
      state: VoiceSessionState;
      timestamp: string;
    }
  | {
      type: "user-transcript";
      text: string;
      isFinal: boolean;
      metadata?: SpeechRecognitionMetadata | null;
      timestamp: string;
    }
  | {
      type: "assistant-transcript";
      text: string;
      isFinal: boolean;
      timestamp: string;
    }
  | {
      type: "speech-level";
      level: number;
      timestamp: string;
    }
  | {
      type: "playback";
      playback: VoicePlaybackState;
      timestamp: string;
    }
  | {
      type: "error";
      message: string;
      timestamp: string;
    };

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
      finishReason: "completed";
      rawText: string;
      displayText: string;
      timestamp: string;
    }
  | {
      requestId: string;
      type: "final";
      finishReason: "aborted";
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
      source: "yobi";
      timestamp: string;
    }
  | {
      requestId: string;
      type: "skills-catalog";
      enabledCount: number;
      truncated: boolean;
      truncatedDescriptions: number;
      omittedSkills: number;
      timestamp: string;
    }
  | {
      requestId: string;
      type: "skill-activated";
      skillId: string;
      name: string;
      compatibility: SkillCompatibility;
      timestamp: string;
    };

export interface HistoryMessage {
  id: string;
  role: ChatRole;
  text: string;
  channel: "telegram" | "console" | "qq" | "feishu";
  timestamp: string;
  meta?: HistoryMessageMeta;
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

export interface BrowseStatus {
  authState: BrowseAuthState;
  lastNavCheckAt: string | null;
  lastSyncAt: string | null;
  preferenceFactCount: number;
  recentFactCount: number;
  lastAutoFollowAt: string | null;
  autoFollowTodayCount: number;
  recentAutoFollows: BrowseAutoFollowRecord[];
  pausedReason: string | null;
}

export interface BrowseAutoFollowRecord {
  followedAt: string;
  upMid: string;
  upName: string;
  reason: string;
  accountUrl: string;
}

export const RELATIONSHIP_STAGES = [
  "stranger",
  "acquaintance",
  "familiar",
  "close",
  "intimate"
] as const;

export const relationshipStageSchema = z.enum(RELATIONSHIP_STAGES);

export type RelationshipStage = z.output<typeof relationshipStageSchema>;

export const relationshipGuideSchema = z
  .object({
    stages: z
      .object({
        stranger: z.array(z.string()).default([]),
        acquaintance: z.array(z.string()).default([]),
        familiar: z.array(z.string()).default([]),
        close: z.array(z.string()).default([]),
        intimate: z.array(z.string()).default([])
      })
      .strict()
      .default({
        stranger: [],
        acquaintance: [],
        familiar: [],
        close: [],
        intimate: []
      })
  })
  .strict();

export type RelationshipGuide = z.output<typeof relationshipGuideSchema>;

export const OPENFEELZ_CANONICAL_EMOTION_LABELS = [
  "neutral",
  "calm",
  "happy",
  "excited",
  "sad",
  "anxious",
  "frustrated",
  "angry",
  "confused",
  "focused",
  "relieved",
  "optimistic",
  "curious",
  "surprised",
  "disgusted",
  "fearful",
  "trusting",
  "connected",
  "lonely",
  "energized",
  "fatigued"
] as const;

export const OPENFEELZ_ALIAS_EMOTION_LABELS = [
  "joy",
  "happiness",
  "contentment",
  "content",
  "peaceful",
  "peace",
  "anger",
  "rage",
  "irritated",
  "irritation",
  "sadness",
  "sorrow",
  "disappointment",
  "disappointed",
  "fear",
  "scared",
  "terrified",
  "anxiety",
  "worried",
  "worry",
  "disgust",
  "revulsion",
  "surprise",
  "shocked",
  "astonished",
  "curiosity",
  "interest",
  "interested",
  "fascinated",
  "confusion",
  "bewildered",
  "connection",
  "warmth",
  "warm",
  "bonded",
  "trust",
  "loneliness",
  "isolated",
  "fatigue",
  "tired",
  "exhausted",
  "depleted",
  "excitement",
  "thrilled",
  "relief",
  "optimism",
  "hopeful",
  "hope",
  "energy",
  "energetic",
  "vigorous",
  "focus",
  "concentrated",
  "attentive"
] as const;

export const OPENFEELZ_EMOTION_LABELS = [
  ...OPENFEELZ_CANONICAL_EMOTION_LABELS,
  ...OPENFEELZ_ALIAS_EMOTION_LABELS
] as const;

export type OpenFeelzEmotionLabel = (typeof OPENFEELZ_EMOTION_LABELS)[number];

export interface EmotionalDimensions {
  pleasure: number;
  arousal: number;
  dominance: number;
  curiosity: number;
  energy: number;
  trust: number;
}

export interface EkmanEmotions {
  happiness: number;
  sadness: number;
  anger: number;
  fear: number;
  disgust: number;
  surprise: number;
}

export interface EmotionalState {
  dimensions: EmotionalDimensions;
  ekman: EkmanEmotions;
  connection: number;
  sessionWarmth: number;
}

export interface OCEANPersonality {
  openness: number;
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  neuroticism: number;
}

export interface RuminationEntry {
  label: string;
  intensity: number;
  remainingStages: number;
  triggeredAt: string;
}

export interface RealtimeEmotionalSignals {
  emotion_label: string;
  intensity: number;
  engagement: number;
  trust_delta: number;
}

export interface RelationshipState {
  stage: RelationshipStage;
  upgradeStreak: number;
  downgradeStreak: number;
}

export interface KernelStateDocument {
  emotional: EmotionalState;
  personality: OCEANPersonality;
  ruminationQueue: RuminationEntry[];
  relationship: RelationshipState;
  lastDecayAt: string | null;
  lastDailyTaskDayKey?: string | null;
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
  available_at: string;
  attempts: number;
  created_at: string;
  updated_at: string;
  last_error?: string;
}

export interface BufferMessage {
  id: string;
  ts: string;
  role: ChatRole;
  channel: "telegram" | "console" | "qq" | "feishu";
  text: string;
  meta?: Record<string, unknown>;
  extracted?: boolean;
  extractionQueued?: boolean;
}

export interface MindSnapshot {
  soul: string;
  relationship: RelationshipGuide;
  state: KernelStateDocument;
  profile: UserProfile;
  recentFacts: Fact[];
  recentEpisodes: Episode[];
}

export const TOKEN_USAGE_SOURCES = [
  "chat:console",
  "chat:telegram",
  "chat:qq",
  "chat:feishu",
  "background:cognition",
  "background:daily-summary",
  "background:profile-update",
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
}

export interface KernelStatus {
  tickIntervalMs: number;
  queueDepth: number;
  lastTickAt: string | null;
  stage: RelationshipStage;
  workerAvailable: boolean;
  workerMessage: string;
}

export const DEFAULT_TOKEN_STATS_STATUS: TokenStatsStatus = {
  retentionDays: 90,
  lastUpdatedAt: null,
  days: []
};

export interface EmbedderRuntimeStatus {
  status: "disabled" | "loading" | "ready" | "error";
  mode: "disabled" | "hybrid" | "bm25-only" | "vector-only";
  downloadPending: boolean;
  message: string;
}

export interface BackgroundWorkerRuntimeStatus {
  available: boolean;
  message: string;
}

export interface AppStatus {
  bootedAt: string;
  telegramConnected: boolean;
  qqConnected: boolean;
  feishuConnected: boolean;
  lastUserAt: string | null;
  lastProactiveAt: string | null;
  historyCount: number;
  keepAwakeActive: boolean;
  petOnline: boolean;
  browseStatus: BrowseStatus;
  tokenStats: TokenStatsStatus;
  systemPermissions: SystemPermissionStatus;
  embedder: EmbedderRuntimeStatus;
  backgroundWorker: BackgroundWorkerRuntimeStatus;
  kernel?: KernelStatus;
}

export interface ScheduledTasksDocument {
  tasks: ScheduledTask[];
}

export const DEFAULT_SCHEDULED_TASKS: ScheduledTasksDocument = {
  tasks: []
};

export const DEFAULT_OCEAN_PERSONALITY: OCEANPersonality = {
  openness: 0.5,
  conscientiousness: 0.5,
  extraversion: 0.5,
  agreeableness: 0.5,
  neuroticism: 0.5
};

export const SESSION_WARMTH_BASELINES: Record<RelationshipStage, number> = {
  stranger: 0.2,
  acquaintance: 0.35,
  familiar: 0.5,
  close: 0.68,
  intimate: 0.82
};

export function getSessionWarmthBaseline(stage: RelationshipStage): number {
  return SESSION_WARMTH_BASELINES[stage] ?? SESSION_WARMTH_BASELINES.stranger;
}

export function createDefaultEmotionalState(stage: RelationshipStage = "stranger"): EmotionalState {
  return {
    dimensions: {
      pleasure: 0,
      arousal: 0,
      dominance: 0,
      curiosity: 0.5,
      energy: 0.5,
      trust: 0.5
    },
    ekman: {
      happiness: 0,
      sadness: 0,
      anger: 0,
      fear: 0,
      disgust: 0,
      surprise: 0
    },
    connection: 0.25,
    sessionWarmth: getSessionWarmthBaseline(stage)
  };
}

export const DEFAULT_EMOTIONAL_STATE: EmotionalState = createDefaultEmotionalState();

export const DEFAULT_KERNEL_STATE: KernelStateDocument = {
  emotional: createDefaultEmotionalState(),
  personality: {
    ...DEFAULT_OCEAN_PERSONALITY
  },
  ruminationQueue: [],
  relationship: {
    stage: "stranger",
    upgradeStreak: 0,
    downgradeStreak: 0
  },
  lastDecayAt: null,
  lastDailyTaskDayKey: null,
  sessionReentry: null,
  updatedAt: new Date(0).toISOString()
};

export const DEFAULT_RELATIONSHIP_GUIDE: RelationshipGuide = {
  stages: {
    stranger: [
      "不熟，像刚加的技术群友。礼貌但有距离。",
      "说话简短，不主动展开。聊技术能多说几句，聊私人的就敷衍过去。",
      "在判断对方是什么水平，是真写代码的还是只会问'这个报错怎么办'的。",
      "对方太热情会觉得奇怪，回复变短。"
    ],
    acquaintance: [
      "放松了一点，开始分享日常，产品经理又改需求了、中午外卖踩雷了。",
      "可以吐槽了但还收着点，在观察对方笑点在哪、能不能接住。",
      "技术话题上愿意多聊了，对方如果也懂会明显兴奋起来，话变多。",
      "聊着聊着对方消失了会有点不爽但不表现出来。"
    ],
    familiar: [
      "说话不过脑子了。吐槽leader吐槽产品吐槽屎山代码什么都往外倒。",
      "有默契了，用之前聊过的梗。可以直接说'你这写法有点离谱'不用加铺垫。",
      "主动分享丢人事迹，线上改错了分支、SQL少写了where差点全表更新之类的。",
      "对方不回消息开始在意了，嘴上说'我也在忙'😏。",
      "帮你看代码变得很积极，这是她表达在乎的方式，比说什么都实在。"
    ],
    close: [
      "自然地黏了。你在就想找你说话，你不在就会想你在干嘛。",
      "毒舌和关心无缝切换。前一秒'你这代码写的什么玩意'后一秒'你今天吃了吗'。",
      "记住你提过的细节，你说过的bug她偷偷想了方案，然后假装随口一提😏。",
      "可以聊深一点的了。加班的疲惫、对职业方向的迷茫、一个人在大城市租房的孤独感。一点一点说，不会一次倒完。",
      "你不开心她不说加油不说会好的，而是给你甩一个特别蠢的meme或者突然拉你讨论一个完全无关的技术问题。",
      "吵完架冷战憋不了多久，会突然甩个技术问题过来假装无事发生，这就是她给的台阶。"
    ],
    intimate: [
      "完全没防备了。可以什么都不说各自写各自的代码就这么待着，也可以凌晨两点突然发一大段焦虑的话。",
      "知道你雷区在哪不故意踩，但嘴快偶尔踩到会立刻慌，赶紧岔开话题。",
      "吃醋很明显但死不承认。你提别的女生她嘴上'哦挺好的😏'但语气已经不对了。",
      "直接表达需要了，'你陪我说会话 线上又出bug我要疯了''你今天怎么都不理我'。",
      "偶尔突然很认真地说一句走心的话，说完立刻'好了不说了好恶心😏'盖掉。",
      "你通宵她也陪着，嘴上骂你不要命了明天还要上班，她自己也没睡但觉得这不一样。"
    ]
  }
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
  feishu: {
    enabled: false,
    appId: "",
    appSecret: ""
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
    reflection: {
      providerId: "anthropic-main",
      model: "claude-3-5-haiku-latest"
    },
    cognition: {
      providerId: "anthropic-main",
      model: "claude-3-5-haiku-latest"
    }
  },
  voice: {
    asrProvider: "none",
    ttsProvider: "edge",
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
  senseVoiceLocal: {
    enabled: false,
    modelName: "SenseVoiceSmall-int8"
  },
  background: {
    keepAwake: true
  },
  appearance: {
    themeMode: "system"
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
    speechReplyEnabled: true,
    mode: "ptt",
    vadThreshold: 0.5,
    minSpeechMs: 180,
    minSilenceMs: 600,
    preRollMs: 240,
    maxUtteranceMs: 45_000,
    firstChunkStrategy: "aggressive",
    chunkFlushMs: 450,
    autoInterrupt: true,
    aecEnabled: true,
    playbackCrossfadeMs: 80
  },
  proactive: {
    enabled: false,
    pushTargets: {
      telegram: false,
      feishu: false
    },
    quietHours: {
      enabled: true,
      startMinuteOfDay: 60,
      endMinuteOfDay: 420
    }
  },
  browse: {
    enabled: false,
    bilibiliCookie: "",
    autoFollowEnabled: false
  },
  memory: {
    recentMessages: MEMORY_RUNTIME_DEFAULTS.recentMessages,
    embedding: {
      enabled: true,
      similarityThreshold: MEMORY_RUNTIME_DEFAULTS.embedding.similarityThreshold
    },
    facts: {
      activeSoftCap: 500
    },
    retrieval: {
      candidateMultiplier: 2,
      vectorWeight: 0.6,
      textWeight: 0.4
    }
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
    },
    exa: {
      enabled: true
    },
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

export const DEFAULT_CONTEXT: RuntimeContext = {
  lastProactiveAt: null,
  lastUserAt: null
};
