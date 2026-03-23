export interface ConsoleRequestHandleState {
  finalized: boolean;
  finishReason?: "completed" | "aborted" | "error";
  finalEventEmitted: boolean;
}

export interface ConsolePostReplyPayload {
  channel: "console";
  userText: string;
  assistantText: string;
}

interface EmitConsoleFinalInput {
  requestId: string;
  handle: ConsoleRequestHandleState;
  finishReason: "completed" | "aborted";
  displayText?: string;
  emit: (event: Record<string, unknown>) => void;
  now?: () => string;
}

interface CompleteConsoleReplyInput {
  requestId: string;
  handle: ConsoleRequestHandleState;
  visibleReply: string;
  userText: string;
  emitFinal: (
    requestId: string,
    handle: ConsoleRequestHandleState,
    finishReason: "completed" | "aborted",
    displayText?: string
  ) => void;
  emitPetTalkingReply: (text: string) => void;
  runPostReplyTasks: (payload: ConsolePostReplyPayload) => Promise<void>;
}

interface RunConsolePostReplyTasksInput extends ConsolePostReplyPayload {
  ingestDialogue: (payload: ConsolePostReplyPayload) => Promise<void>;
  onAssistantMessage: () => Promise<void>;
  emitStatus: () => Promise<void>;
  warn: (
    scope: string,
    event: string,
    payload: Record<string, unknown> | undefined,
    error: unknown
  ) => void;
}

export function emitConsoleFinal(input: EmitConsoleFinalInput): void {
  if (input.handle.finalEventEmitted) {
    return;
  }

  input.handle.finalEventEmitted = true;
  const timestamp = input.now?.() ?? new Date().toISOString();
  if (input.finishReason === "aborted") {
    input.emit({
      requestId: input.requestId,
      type: "final",
      finishReason: "aborted",
      timestamp
    });
    return;
  }

  const visibleText = input.displayText?.trim() || "我这次没有生成有效回复，请重试一次。";
  input.emit({
    requestId: input.requestId,
    type: "final",
    finishReason: "completed",
    rawText: visibleText,
    displayText: visibleText,
    timestamp
  });
}

export function completeConsoleReply(input: CompleteConsoleReplyInput): void {
  input.handle.finalized = true;
  input.handle.finishReason = "completed";
  input.emitFinal(input.requestId, input.handle, "completed", input.visibleReply);
  input.emitPetTalkingReply(input.visibleReply);
  void input.runPostReplyTasks({
    channel: "console",
    userText: input.userText,
    assistantText: input.visibleReply
  });
}

export async function runConsolePostReplyTasks(
  input: RunConsolePostReplyTasksInput
): Promise<void> {
  try {
    await input.ingestDialogue({
      channel: input.channel,
      userText: input.userText,
      assistantText: input.assistantText
    });
    await input.onAssistantMessage();
    await input.emitStatus();
  } catch (error) {
    input.warn("runtime", "console-post-reply-failed", undefined, error);
  }
}
