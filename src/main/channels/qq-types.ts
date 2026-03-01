export interface QQAccessTokenResponse {
  access_token: string;
  expires_in: string;
}

export interface QQGatewayPayload {
  id?: string;
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}

export interface QQGatewayHelloData {
  heartbeat_interval: number;
}

export interface QQGatewayReadyEvent {
  session_id: string;
  user?: {
    id?: string;
    username?: string;
  };
}

export interface QQMessageAttachment {
  content_type: string;
  filename?: string;
  url: string;
  width?: number;
  height?: number;
  size?: number;
}

export interface QQC2CMessageEvent {
  id: string;
  content: string;
  timestamp: string;
  author: {
    user_openid: string;
  };
  attachments?: QQMessageAttachment[];
}

export interface QQSendC2CMessageBody {
  content?: string;
  msg_type: number;
  msg_id?: string;
  msg_seq?: number;
  markdown?: unknown;
  keyboard?: unknown;
  media?: unknown;
}

export interface QQChannelConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
}

export const QQ_OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11
} as const;

export const QQ_INTENTS_C2C = 1 << 25;
