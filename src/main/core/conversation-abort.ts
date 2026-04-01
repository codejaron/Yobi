export class ConversationAbortError extends Error {
  constructor(message = "LLM 回复已中断。") {
    super(message);
    this.name = "ConversationAbortError";
  }
}

export function isConversationAbortError(error: unknown): error is ConversationAbortError {
  return error instanceof ConversationAbortError;
}

export function isAbortLikeError(error: unknown): boolean {
  if (isConversationAbortError(error)) {
    return true;
  }

  if (error instanceof Error) {
    const message = error.message.trim().toLowerCase();
    return (
      error.name === "AbortError" ||
      message === "terminated" ||
      message === "aborted" ||
      message === "this operation was aborted"
    );
  }

  return false;
}
