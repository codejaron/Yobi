export type ConsoleComposerKeyAction =
  | "none"
  | "submit"
  | "approval-up"
  | "approval-down"
  | "approval-confirm"
  | "slash-up"
  | "slash-down"
  | "slash-confirm"
  | "slash-close";

export function getConsoleComposerKeyAction(input: {
  key: string;
  shiftKey: boolean;
  pendingApproval: boolean;
  isComposing: boolean;
  slashMenuOpen: boolean;
}): ConsoleComposerKeyAction {
  if (input.pendingApproval) {
    if (input.key === "ArrowUp") {
      return "approval-up";
    }

    if (input.key === "ArrowDown") {
      return "approval-down";
    }

    if (input.key === "Enter") {
      return "approval-confirm";
    }

    return "none";
  }

  if (input.isComposing) {
    return "none";
  }

  if (input.slashMenuOpen) {
    if (input.key === "ArrowUp") {
      return "slash-up";
    }

    if (input.key === "ArrowDown") {
      return "slash-down";
    }

    if (input.key === "Enter") {
      return "slash-confirm";
    }

    if (input.key === "Escape") {
      return "slash-close";
    }

    return "none";
  }

  if (input.key === "Enter" && !input.shiftKey) {
    return "submit";
  }

  return "none";
}
