import type { ChatReplyStreamListener } from "@main/core/conversation";
import type { ConversationEngine } from "@main/core/conversation";
import type { ToolApprovalHandler } from "@main/tools/types";
import type { ChatAttachment, VoiceInputContext } from "@shared/types";

export class ChannelRouter {
  constructor(private readonly conversation: ConversationEngine) {}

  async handleConsole(input: {
    text: string;
    attachments?: ChatAttachment[];
    resourceId: string;
    threadId: string;
    taskMode?: boolean;
    voiceContext?: VoiceInputContext;
    stream?: ChatReplyStreamListener;
    requestApproval?: ToolApprovalHandler;
    abortSignal?: AbortSignal;
  }): Promise<string> {
    return this.conversation.reply({
      text: input.text,
      attachments: input.attachments,
      channel: "console",
      resourceId: input.resourceId,
      threadId: input.threadId,
      taskMode: input.taskMode,
      voiceContext: input.voiceContext,
      stream: input.stream,
      requestApproval: input.requestApproval,
      abortSignal: input.abortSignal
    });
  }

  async handleTelegram(input: {
    text: string;
    photoUrl?: string;
    resourceId: string;
    threadId: string;
    requestApproval?: ToolApprovalHandler;
  }): Promise<string> {
    return this.conversation.reply({
      text: input.text,
      channel: "telegram",
      photoUrl: input.photoUrl,
      resourceId: input.resourceId,
      threadId: input.threadId,
      requestApproval: input.requestApproval
    });
  }

  async handleQQ(input: {
    text: string;
    photoUrl?: string;
    resourceId: string;
    threadId: string;
    requestApproval?: ToolApprovalHandler;
  }): Promise<string> {
    return this.conversation.reply({
      text: input.text,
      channel: "qq",
      photoUrl: input.photoUrl,
      resourceId: input.resourceId,
      threadId: input.threadId,
      requestApproval: input.requestApproval
    });
  }

  async handleFeishu(input: {
    text: string;
    photoUrl?: string;
    resourceId: string;
    threadId: string;
    stream?: ChatReplyStreamListener;
    requestApproval?: ToolApprovalHandler;
  }): Promise<string> {
    return this.conversation.reply({
      text: input.text,
      channel: "feishu",
      photoUrl: input.photoUrl,
      resourceId: input.resourceId,
      threadId: input.threadId,
      stream: input.stream,
      requestApproval: input.requestApproval
    });
  }
}
