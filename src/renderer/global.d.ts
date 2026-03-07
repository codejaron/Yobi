import type { CompanionApi } from "@shared/ipc";

declare global {
  interface Window {
    companion: CompanionApi;
    petApi?: unknown;
  }
}

export {};
