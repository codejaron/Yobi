import type {
  AppConfig,
  AppStatus,
  CharacterProfile,
  CommandApprovalDecision,
  ConsoleChatEvent,
  HistoryMessage,
  MemoryFact
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

  listMemory(): Promise<MemoryFact[]>;
  upsertMemory(input: { id?: string; content: string; confidence: number }): Promise<MemoryFact>;
  deleteMemory(id: string): Promise<void>;
  clearMemory(): Promise<void>;
  openMemoryFileLocation(): Promise<{ path: string }>;

  getStatus(): Promise<AppStatus>;
  openSystemPermissionSettings(
    permission: keyof AppStatus["systemPermissions"]
  ): Promise<{ opened: boolean }>;
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
  onConsoleChatEvent(listener: (event: ConsoleChatEvent) => void): () => void;
}
