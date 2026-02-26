import type {
  AppConfig,
  AppStatus,
  CharacterProfile,
  MemoryFact
} from "@shared/types";

export type PageId =
  | "dashboard"
  | "console"
  | "providers"
  | "character"
  | "memory"
  | "mcp"
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
}
