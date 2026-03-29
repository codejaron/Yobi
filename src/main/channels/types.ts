import type { ChatAttachment } from "@shared/types";

export interface InboundMessage {
  kind: "text" | "photo";
  chatId: string;
  text: string;
  fromUserId: string;
  sentAt: string;
  attachments?: ChatAttachment[];
  photoUrl?: string;
}

type OutboundBase = {
  chatId?: string;
};

export type OutboundMessage =
  | (OutboundBase & {
      kind: "text";
      text: string;
    })
  | (OutboundBase & {
      kind: "voice";
      audio: Buffer;
      caption?: string;
      filename?: string;
    })
  | (OutboundBase & {
      kind: "photo";
      photoUrl?: string;
      photoPath?: string;
      caption?: string;
    });

export interface ChatChannel {
  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;
  send(message: OutboundMessage): Promise<void>;
  isConnected(): boolean;
  stop(): Promise<void>;
}
