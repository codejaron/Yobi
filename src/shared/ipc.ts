import type {
  AppConfig,
  AppStatus,
  BrowseAuthState,
  ConsoleChatAttachmentInput,
  CommandApprovalDecision,
  ConsoleRunEventV2,
  HistoryMessage,
  KernelStateDocument,
  MindSnapshot,
  RelationshipGuide,
  SkillCatalogItem,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskRun,
  UserProfile,
  VoiceInputContext,
  VoiceSessionEvent,
  VoiceSessionState,
  VoiceTranscriptionResult,
  RealtimeVoiceMode,
  VoiceSessionTarget
} from "./types";
import type { ProviderModelListResult } from "./provider-catalog";
import type { CognitionConfig, CognitionConfigPatch, CognitionDebugSnapshot } from "./cognition";

export interface CursorHistoryPage {
  items: HistoryMessage[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface SpeechRecognitionStatus {
  ready: boolean;
  provider: "sensevoice-local" | "alibaba" | "none";
  message: string;
}

export interface SenseVoiceModelStatus {
  enabled: boolean;
  modelName: AppConfig["senseVoiceLocal"]["modelName"];
  downloaded: boolean;
  ready: boolean;
  errorMessage?: string | null;
}

export interface SenseVoiceModelProgressEvent {
  modelName: AppConfig["senseVoiceLocal"]["modelName"];
  percent: number;
}

export interface ConsoleChatRequestInput {
  text: string;
  attachments?: ConsoleChatAttachmentInput[];
  voiceContext?: VoiceInputContext;
  taskMode?: boolean;
}

export interface CompanionApi {
  getConfig(): Promise<AppConfig>;
  saveConfig(config: AppConfig): Promise<AppConfig>;
  listProviderModels(input: { provider: AppConfig["providers"][number] }): Promise<ProviderModelListResult>;
  getSpeechRecognitionStatus(): Promise<SpeechRecognitionStatus>;
  ensureSenseVoiceModel(input?: {
    modelName?: AppConfig["senseVoiceLocal"]["modelName"];
  }): Promise<{ ready: boolean; path: string }>;
  getSenseVoiceModelStatus(input?: {
    modelName?: AppConfig["senseVoiceLocal"]["modelName"];
  }): Promise<SenseVoiceModelStatus>;
  onSenseVoiceModelDownloadProgress(listener: (event: SenseVoiceModelProgressEvent) => void): () => void;

  listHistory(query?: { query?: string; limit?: number; offset?: number }): Promise<HistoryMessage[]>;
  clearHistory(): Promise<void>;

  getMindSnapshot(): Promise<MindSnapshot>;
  getSoul(): Promise<{ markdown: string; updatedAt: string }>;
  saveSoul(input: { markdown: string }): Promise<{ markdown: string; updatedAt: string }>;
  getRelationship(): Promise<{ guide: RelationshipGuide; updatedAt: string }>;
  saveRelationship(input: { guide: RelationshipGuide }): Promise<{ guide: RelationshipGuide; updatedAt: string }>;
  patchState(input: { patch: Partial<KernelStateDocument> }): Promise<KernelStateDocument>;
  patchProfile(input: { patch: Partial<UserProfile> }): Promise<UserProfile>;
  resetMindSection(input: {
    section: "soul" | "relationship" | "state" | "profile" | "facts" | "episodes";
  }): Promise<{ accepted: boolean; message: string }>;
  triggerKernelTask(taskType: "tick-now" | "daily-now"): Promise<{ accepted: boolean; message: string }>;

  getStatus(): Promise<AppStatus>;
  startBilibiliQrAuth(): Promise<{
    authState: BrowseAuthState;
    qrcodeKey: string;
    scanUrl: string;
    expiresAt: string;
  }>;
  pollBilibiliQrAuth(input: { qrcodeKey: string }): Promise<{
    authState: BrowseAuthState;
    status: "pending" | "scanned" | "confirmed" | "expired" | "error";
    detail: string;
    cookieSaved: boolean;
  }>;
  saveBilibiliCookie(input: { cookie: string }): Promise<{
    saved: boolean;
    message: string;
    authState: BrowseAuthState;
  }>;
  triggerBilibiliSync(): Promise<{ accepted: boolean; message: string }>;
  openBilibiliAccount(): Promise<{ opened: boolean; message: string }>;
  openSystemPermissionSettings(
    permission: keyof AppStatus["systemPermissions"]
  ): Promise<{ opened: boolean; prompted: boolean }>;
  resetSystemPermissions(): Promise<{ reset: boolean; message?: string }>;
  importPetModelFromDialog(): Promise<{
    canceled: boolean;
    modelDir?: string;
  }>;
  onStatus(listener: (status: AppStatus) => void): () => void;
  onPetEnabledChange(listener: (enabled: boolean) => void): () => void;

  sendConsoleChat(input: ConsoleChatRequestInput): Promise<{ requestId: string }>;
  sendConsoleChatWithVoice(input: ConsoleChatRequestInput): Promise<{ requestId: string }>;
  stopConsoleChat(requestId: string): Promise<{ accepted: boolean }>;
  transcribeVoice(input: {
    pcm16Base64: string;
    sampleRate: number;
  }): Promise<VoiceTranscriptionResult>;
  getVoiceSessionState(): Promise<VoiceSessionState>;
  startVoiceSession(input?: {
    mode?: RealtimeVoiceMode;
    target?: Partial<VoiceSessionTarget>;
  }): Promise<VoiceSessionState>;
  stopVoiceSession(): Promise<{ accepted: boolean }>;
  interruptVoiceSession(input?: {
    reason?: "vad" | "manual" | "system";
  }): Promise<{ accepted: boolean }>;
  setVoiceSessionMode(mode: RealtimeVoiceMode): Promise<VoiceSessionState>;
  listConsoleHistory(input?: {
    cursor?: string;
    limit?: number;
  }): Promise<CursorHistoryPage>;
  approveConsoleCommand(input: {
    approvalId: string;
    decision: CommandApprovalDecision;
  }): Promise<{ accepted: boolean }>;
  onConsoleRunEvent(listener: (event: ConsoleRunEventV2) => void): () => void;
  onVoiceSessionEvent(listener: (event: VoiceSessionEvent) => void): () => void;

  listScheduledTasks(): Promise<{ tasks: ScheduledTask[]; runs: ScheduledTaskRun[] }>;
  saveScheduledTask(input: ScheduledTaskInput): Promise<ScheduledTask>;
  pauseScheduledTask(taskId: string): Promise<ScheduledTask>;
  resumeScheduledTask(taskId: string): Promise<ScheduledTask>;
  deleteScheduledTask(taskId: string): Promise<{ removed: boolean }>;
  runScheduledTaskNow(taskId: string): Promise<ScheduledTaskRun>;

  listSkills(): Promise<SkillCatalogItem[]>;
  rescanSkills(): Promise<SkillCatalogItem[]>;
  importSkillFolder(): Promise<{ canceled: boolean; skill?: SkillCatalogItem }>;
  setSkillEnabled(input: { skillId: string; enabled: boolean }): Promise<SkillCatalogItem>;
  deleteSkill(skillId: string): Promise<{ removed: boolean; skillId: string }>;

  getCognitionDebugSnapshot(): Promise<CognitionDebugSnapshot>;
  triggerCognitionManualSpread(input: { text: string }): Promise<{
    entry: CognitionDebugSnapshot["lastLogs"][number];
    snapshot: CognitionDebugSnapshot;
  }>;
  updateCognitionConfig(input: CognitionConfigPatch): Promise<CognitionConfig>;
  onCognitionTickCompleted(listener: (entry: CognitionDebugSnapshot["lastLogs"][number]) => void): () => void;
}
