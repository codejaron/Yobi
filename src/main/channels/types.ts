export interface InboundMessage {
  kind: "text" | "photo";
  text: string;
  fromUserId: string;
  sentAt: string;
  photoUrl?: string;
}

export type OutboundMessage =
  | {
      kind: "text";
      text: string;
    }
  | {
      kind: "voice";
      audio: Buffer;
      caption?: string;
      filename?: string;
    }
  | {
      kind: "photo";
      photoUrl?: string;
      photoPath?: string;
      caption?: string;
    };

export interface ChatChannel {
  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;
  send(message: OutboundMessage): Promise<void>;
  isConnected(): boolean;
  stop(): Promise<void>;
}
