export type ClawChatRole = "assistant" | "user" | "error";

export interface ClawChatItem {
  id: string;
  role: ClawChatRole;
  title: string;
  text: string;
  timestamp: string;
  streaming?: boolean;
}

export interface ClawActionItem {
  id: string;
  kind: "tool" | "status" | "error";
  label: string;
  detail: string;
  timestamp: string;
}

export interface ConnectionBadge {
  label: string;
  className: string;
}
