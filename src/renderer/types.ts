import type {
  AppConfig,
  AppStatus
} from "@shared/types";

export type PageId =
  | "dashboard"
  | "topics"
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
