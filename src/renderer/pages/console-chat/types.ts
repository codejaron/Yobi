import type {
  CommandApprovalDecision,
  HistoryMessage,
  SkillActivatedEventPayload,
  SkillsCatalogSummary
} from "@shared/types";
import type { AssistantTurnProcess } from "@shared/tool-trace";

export type MessageRole = "user" | "assistant";
export type MessageState = "streaming" | "done" | "error";

export interface ConsoleMessage {
  id: string;
  requestId: string;
  role: MessageRole;
  text: string;
  state: MessageState;
  process?: AssistantTurnProcess;
  source?: "yobi";
  historyMode?: boolean;
}

export interface PendingApproval {
  requestId: string;
  approvalId: string;
  toolName: string;
  description: string;
}

export type ConsoleSkillsCatalogState = SkillsCatalogSummary;
export type ConsoleActivatedSkill = SkillActivatedEventPayload;

export const CONSOLE_HISTORY_PAGE_SIZE = 20;

export const APPROVAL_OPTIONS: Array<{ decision: CommandApprovalDecision; label: string }> = [
  { decision: "allow-once", label: "同意一次" },
  { decision: "allow-always", label: "同意并记住" },
  { decision: "deny", label: "拒绝" }
];

export function historyRoleToMessageRole(role: HistoryMessage["role"]): MessageRole {
  return role === "assistant" ? "assistant" : "user";
}

export function appendRecognizedText(currentDraft: string, recognizedText: string): string {
  const normalized = recognizedText.trim();
  if (!normalized) {
    return currentDraft;
  }

  const current = currentDraft.trim();
  if (!current) {
    return normalized;
  }

  return `${current} ${normalized}`;
}
