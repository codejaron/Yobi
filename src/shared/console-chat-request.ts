import type { ConsoleChatRequestInput } from "./ipc";

export function buildConsoleChatRequestPayload(input: ConsoleChatRequestInput): ConsoleChatRequestInput {
  return {
    text: input.text,
    ...(input.attachments && input.attachments.length > 0
      ? {
          attachments: input.attachments
        }
      : {}),
    ...(input.voiceContext
      ? {
          voiceContext: input.voiceContext
        }
      : {}),
    taskMode: input.taskMode === true
  };
}
