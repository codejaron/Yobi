import type {
  AppConfig,
  AppStatus,
  CharacterProfile,
  HistoryMessage,
  MemoryFact
} from "./types";

export interface CompanionApi {
  getConfig(): Promise<AppConfig>;
  saveConfig(config: AppConfig): Promise<AppConfig>;

  getCharacter(characterId: string): Promise<CharacterProfile>;
  saveCharacter(profile: CharacterProfile): Promise<void>;

  listHistory(query?: { query?: string; limit?: number; offset?: number }): Promise<HistoryMessage[]>;

  listMemory(): Promise<MemoryFact[]>;
  upsertMemory(input: { id?: string; content: string; confidence: number }): Promise<MemoryFact>;
  deleteMemory(id: string): Promise<void>;

  getStatus(): Promise<AppStatus>;
  onStatus(listener: (status: AppStatus) => void): () => void;
}
