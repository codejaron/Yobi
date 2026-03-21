import type {
  AppConfig,
  AppStatus
} from "@shared/types";

export type PageId =
  | "dashboard"
  | "console"
  | "scheduler"
  | "skills"
  | "providers"
  | "memory"
  | "mcp"
  | "cognition"
  | "settings";

export interface PageProps {
  config: AppConfig;
  setConfig: (next: AppConfig) => void;
  status: AppStatus | null;
  refreshStatus: () => Promise<void>;
}
