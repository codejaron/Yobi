import type {
  AppConfig,
  AppStatus,
  CharacterProfile,
  HistoryMessage,
  MemoryFact
} from "@shared/types";

export type PageId =
  | "dashboard"
  | "providers"
  | "character"
  | "memory"
  | "history"
  | "settings";

export interface PageProps {
  config: AppConfig;
  setConfig: (next: AppConfig) => void;
  status: AppStatus | null;
  refreshStatus: () => Promise<void>;
}

export interface DataBundle {
  config: AppConfig;
  status: AppStatus | null;
  character: CharacterProfile | null;
  memoryFacts: MemoryFact[];
  history: HistoryMessage[];
}
