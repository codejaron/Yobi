import type {
  ChatAttachment,
  CommandApprovalDecision,
  ConsoleChatAttachmentInput,
  HistoryMessage,
  SkillActivatedEventPayload,
  SkillsCatalogSummary
} from "@shared/types";
import type {
  ConsoleChatFeedMessage,
  ConsoleChatFeedMessageRole,
  ConsoleChatFeedMessageState
} from "@shared/console-chat-feed";

export type MessageRole = ConsoleChatFeedMessageRole;
export type MessageState = ConsoleChatFeedMessageState;

export interface ConsoleAttachmentView {
  id: string;
  kind: ChatAttachment["kind"];
  filename: string;
  mimeType: string;
  size: number;
  path?: string;
  previewUrl?: string;
  source: ChatAttachment["source"] | "draft";
  input?: ConsoleChatAttachmentInput;
}

export type ConsoleMessage = ConsoleChatFeedMessage<ConsoleAttachmentView>;

export interface PendingApproval {
  requestId: string;
  approvalId: string;
  toolName: string;
  description: string;
}

export type ConsoleSkillsCatalogState = SkillsCatalogSummary;
export type ConsoleActivatedSkill = SkillActivatedEventPayload;

export const CONSOLE_HISTORY_PAGE_SIZE = 50;

export const APPROVAL_OPTIONS: Array<{ decision: CommandApprovalDecision; label: string }> = [
  { decision: "allow-once", label: "同意一次" },
  { decision: "allow-always", label: "同意并记住" },
  { decision: "deny", label: "拒绝" }
];

export function historyRoleToMessageRole(role: HistoryMessage["role"]): MessageRole {
  return role === "assistant" ? "assistant" : "user";
}

export function toConsoleAttachmentView(attachment: ChatAttachment): ConsoleAttachmentView {
  return {
    id: attachment.id,
    kind: attachment.kind,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
    path: attachment.path,
    source: attachment.source
  };
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
