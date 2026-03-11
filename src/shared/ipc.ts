import type {
  AppConfig,
  AppStatus,
  BrowseAuthState,
  CommandApprovalDecision,
  ConsoleRunEventV2,
  HistoryMessage,
  KernelStateDocument,
  MindSnapshot,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskRun,
  UserProfile
} from "./types";

export interface CursorHistoryPage {
  items: HistoryMessage[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface SpeechRecognitionStatus {
  ready: boolean;
  provider: "whisper-local" | "alibaba" | "none";
  message: string;
}

export interface WhisperModelStatus {
  enabled: boolean;
  modelSize: AppConfig["whisperLocal"]["modelSize"];
  downloaded: boolean;
  ready: boolean;
}

export interface WhisperModelProgressEvent {
  modelSize: AppConfig["whisperLocal"]["modelSize"];
  percent: number;
}

export interface CompanionApi {
  getConfig(): Promise<AppConfig>;
  saveConfig(config: AppConfig): Promise<AppConfig>;
  getSpeechRecognitionStatus(): Promise<SpeechRecognitionStatus>;
  ensureWhisperModel(input?: {
    modelSize?: AppConfig["whisperLocal"]["modelSize"];
  }): Promise<{ ready: boolean; path: string }>;
  getWhisperModelStatus(input?: {
    modelSize?: AppConfig["whisperLocal"]["modelSize"];
  }): Promise<WhisperModelStatus>;
  onWhisperModelDownloadProgress(listener: (event: WhisperModelProgressEvent) => void): () => void;

  listHistory(query?: { query?: string; limit?: number; offset?: number }): Promise<HistoryMessage[]>;
  clearHistory(): Promise<void>;

  getMindSnapshot(): Promise<MindSnapshot>;
  getSoul(): Promise<{ markdown: string; updatedAt: string }>;
  saveSoul(input: { markdown: string }): Promise<{ markdown: string; updatedAt: string }>;
  getPersona(): Promise<{ markdown: string; updatedAt: string }>;
  savePersona(input: { markdown: string }): Promise<{ markdown: string; updatedAt: string }>;
  patchState(input: { patch: Partial<KernelStateDocument> }): Promise<KernelStateDocument>;
  patchProfile(input: { patch: Partial<UserProfile> }): Promise<UserProfile>;
  resetMindSection(input: {
    section: "soul" | "persona" | "state" | "profile" | "facts" | "episodes";
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
  triggerTopicRecall(): Promise<{ accepted: boolean; message: string }>;
  triggerBilibiliSync(): Promise<{ accepted: boolean; message: string }>;
  openBilibiliAccount(): Promise<{ opened: boolean; message: string }>;
  deleteTopicPoolItem(topicId: string): Promise<{ accepted: boolean; message: string }>;
  clearTopicPool(): Promise<{ accepted: boolean; message: string }>;
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

  sendConsoleChat(text: string): Promise<{ requestId: string }>;
  transcribeVoice(input: {
    pcm16Base64: string;
    sampleRate: number;
  }): Promise<{ text: string }>;
  listConsoleHistory(input?: {
    cursor?: string;
    limit?: number;
  }): Promise<CursorHistoryPage>;
  approveConsoleCommand(input: {
    approvalId: string;
    decision: CommandApprovalDecision;
  }): Promise<{ accepted: boolean }>;
  onConsoleRunEvent(listener: (event: ConsoleRunEventV2) => void): () => void;

  listScheduledTasks(): Promise<{ tasks: ScheduledTask[]; runs: ScheduledTaskRun[] }>;
  saveScheduledTask(input: ScheduledTaskInput): Promise<ScheduledTask>;
  pauseScheduledTask(taskId: string): Promise<ScheduledTask>;
  resumeScheduledTask(taskId: string): Promise<ScheduledTask>;
  deleteScheduledTask(taskId: string): Promise<{ removed: boolean }>;
  runScheduledTaskNow(taskId: string): Promise<ScheduledTaskRun>;
}
