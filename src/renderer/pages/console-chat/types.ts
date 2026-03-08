import type { CommandApprovalDecision, HistoryMessage } from "@shared/types";

export type MessageRole = "user" | "assistant";
export type MessageState = "streaming" | "done" | "error";
export type ActionKind = "thinking" | "tool" | "approval" | "status" | "error";

export interface ConsoleMessage {
  id: string;
  requestId: string;
  role: MessageRole;
  text: string;
  state: MessageState;
  source?: "claw" | "yobi";
}

export interface ActionItem {
  id: string;
  requestId: string;
  kind: ActionKind;
  label: string;
  detail: string;
  timestamp: string;
}

export interface PendingApproval {
  requestId: string;
  approvalId: string;
  toolName: string;
  description: string;
}

export const CONSOLE_HISTORY_PAGE_SIZE = 20;
export const LIVE_MESSAGE_LIMIT = 90;

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

export function actionColor(kind: ActionKind): string {
  if (kind === "thinking") {
    return "border-sky-200 bg-sky-50/90";
  }

  if (kind === "tool") {
    return "border-amber-200 bg-amber-50/90";
  }

  if (kind === "approval") {
    return "border-orange-200 bg-orange-50/90";
  }

  if (kind === "error") {
    return "border-rose-200 bg-rose-50/90";
  }

  return "border-border/70 bg-white/75";
}
