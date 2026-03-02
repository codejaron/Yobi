import type {
  AppConfig,
  AppStatus,
  CharacterProfile,
  ClawEvent,
  ClawHistoryItem,
  CommandApprovalDecision,
  ConsoleRunEventV2,
  HistoryMessage,
  WorkingMemoryDocument
} from "./types";

export interface CursorHistoryPage {
  items: HistoryMessage[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface CompanionApi {
  getConfig(): Promise<AppConfig>;
  saveConfig(config: AppConfig): Promise<AppConfig>;

  getCharacter(characterId: string): Promise<CharacterProfile>;
  saveCharacter(profile: CharacterProfile): Promise<void>;

  listHistory(query?: { query?: string; limit?: number; offset?: number }): Promise<HistoryMessage[]>;
  clearHistory(): Promise<void>;

  getWorkingMemory(): Promise<WorkingMemoryDocument>;
  saveWorkingMemory(input: { markdown: string }): Promise<WorkingMemoryDocument>;

  getStatus(): Promise<AppStatus>;
  triggerRecallTask(): Promise<{ accepted: boolean; message: string }>;
  triggerWanderTask(): Promise<{ accepted: boolean; message: string }>;
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

  clawConnect(): Promise<{ connected: boolean; message: string }>;
  clawDisconnect(): Promise<{ connected: boolean; message: string }>;
  clawSend(message: string): Promise<{ accepted: boolean; message: string }>;
  clawHistory(limit?: number): Promise<{ items: ClawHistoryItem[] }>;
  clawAbort(): Promise<{ accepted: boolean; message: string }>;
  onClawEvent(listener: (event: ClawEvent) => void): () => void;
}
