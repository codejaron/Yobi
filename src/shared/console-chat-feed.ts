import type { AssistantTurnProcess } from "./tool-trace";

export type ConsoleChatFeedMessageRole = "user" | "assistant";
export type ConsoleChatFeedMessageState = "streaming" | "done" | "error";

export interface ConsoleChatFeedMessage<TAttachment = unknown> {
  id: string;
  requestId: string;
  role: ConsoleChatFeedMessageRole;
  text: string;
  state: ConsoleChatFeedMessageState;
  attachments?: TAttachment[];
  transientOrigin?: "voice";
  process?: AssistantTurnProcess;
  source?: "yobi";
  historyMode?: boolean;
}

export function upsertAssistantConsoleChatFeedMessage<TAttachment>(
  messages: ConsoleChatFeedMessage<TAttachment>[],
  requestId: string,
  updater: (
    current: ConsoleChatFeedMessage<TAttachment>
  ) => ConsoleChatFeedMessage<TAttachment>,
  createMessage: (requestId: string) => ConsoleChatFeedMessage<TAttachment>
): ConsoleChatFeedMessage<TAttachment>[] {
  const index = messages.findIndex(
    (message) => message.requestId === requestId && message.role === "assistant"
  );

  if (index < 0) {
    return [...messages, updater(createMessage(requestId))];
  }

  const next = [...messages];
  next[index] = updater(next[index] as ConsoleChatFeedMessage<TAttachment>);
  return next;
}

export function updateAssistantConsoleChatFeedMessageIfPresent<TAttachment>(
  messages: ConsoleChatFeedMessage<TAttachment>[],
  requestId: string,
  updater: (
    current: ConsoleChatFeedMessage<TAttachment>
  ) => ConsoleChatFeedMessage<TAttachment> | null
): ConsoleChatFeedMessage<TAttachment>[] {
  const index = messages.findIndex(
    (message) => message.requestId === requestId && message.role === "assistant"
  );
  if (index < 0) {
    return messages;
  }

  const nextMessage = updater(messages[index] as ConsoleChatFeedMessage<TAttachment>);
  if (!nextMessage) {
    return messages.filter((message) => message.id !== messages[index]?.id);
  }

  const next = [...messages];
  next[index] = nextMessage;
  return next;
}

export function reconcileTransientConsoleChatFeedMessages<TAttachment>(
  current: ConsoleChatFeedMessage<TAttachment>[],
  nextTransientMessages: ConsoleChatFeedMessage<TAttachment>[],
  transientOrigin: ConsoleChatFeedMessage<TAttachment>["transientOrigin"] = "voice"
): ConsoleChatFeedMessage<TAttachment>[] {
  const nextById = new Map(nextTransientMessages.map((message) => [message.id, message]));
  const emitted = new Set<string>();
  const next: ConsoleChatFeedMessage<TAttachment>[] = [];

  for (const message of current) {
    if (message.transientOrigin !== transientOrigin) {
      next.push(message);
      continue;
    }

    const replacement = nextById.get(message.id);
    if (!replacement) {
      continue;
    }

    next.push(replacement);
    emitted.add(message.id);
  }

  for (const message of nextTransientMessages) {
    if (emitted.has(message.id)) {
      continue;
    }

    next.push(message);
  }

  return next;
}
