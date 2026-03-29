import test from "node:test";
import assert from "node:assert/strict";
import { ChannelCoordinator } from "../runtime/channel-coordinator.js";
import { ChannelRouter } from "../channels/router.js";

test("ChannelCoordinator forwards inbound Telegram attachments to the handler", async () => {
  let telegramInboundHandler: ((message: any) => Promise<void>) | null = null;
  let seenPayload: Record<string, unknown> | null = null;

  const coordinator = new ChannelCoordinator({
    telegram: {
      start: async (handler: (message: any) => Promise<void>) => {
        telegramInboundHandler = handler;
      },
      send: async () => undefined,
      isConnected: () => true,
      stop: async () => undefined
    } as any,
    feishu: {
      start: async () => undefined,
      send: async () => undefined,
      isConnected: () => true,
      stop: async () => undefined,
      startStreaming: async () => undefined,
      pushStreamingDelta: async () => undefined,
      finishStreaming: async () => undefined
    } as any,
    createQQChannel: () => {
      throw new Error("QQ should not be constructed in this test");
    },
    logger: {
      info() {},
      warn() {},
      error() {}
    } as any,
    pet: {
      emitEvent() {}
    } as any,
    getQQConfig: () => ({ enabled: false, appId: "", appSecret: "" }),
    handleTelegram: async (payload) => {
      seenPayload = payload as Record<string, unknown>;
      return "ok";
    },
    handleQQ: async () => "ok",
    handleFeishu: async () => "ok",
    onRecordUserActivity: async () => undefined,
    onAssistantMessage: async () => undefined,
    emitStatus: async () => undefined,
    withTimeout: async (promise) => promise,
    chatReplyTimeoutMs: 5000,
    resourceId: "primary-user",
    threadId: "primary-thread"
  });

  await coordinator.startTelegram();
  assert.ok(telegramInboundHandler);
  const runTelegramInbound = telegramInboundHandler as (message: any) => Promise<void>;

  const attachments = [
    {
      id: "attachment-1",
      kind: "image",
      filename: "photo.png",
      mimeType: "image/png",
      size: 12,
      path: "/tmp/photo.png",
      source: "user-upload",
      createdAt: new Date().toISOString()
    }
  ];

  await runTelegramInbound({
    kind: "photo",
    chatId: "chat-1",
    text: "",
    fromUserId: "user-1",
    sentAt: new Date().toISOString(),
    attachments
  });

  assert.deepEqual((seenPayload as { attachments?: unknown[] } | null)?.attachments, attachments);
});

test("ChannelCoordinator forwards inbound Feishu attachments to the handler", async () => {
  let feishuInboundHandler: ((message: any) => Promise<void>) | null = null;
  let seenPayload: Record<string, unknown> | null = null;

  const coordinator = new ChannelCoordinator({
    telegram: {
      start: async () => undefined,
      send: async () => undefined,
      isConnected: () => true,
      stop: async () => undefined
    } as any,
    feishu: {
      start: async (handler: (message: any) => Promise<void>) => {
        feishuInboundHandler = handler;
      },
      send: async () => undefined,
      isConnected: () => true,
      stop: async () => undefined,
      startStreaming: async () => undefined,
      pushStreamingDelta: async () => undefined,
      finishStreaming: async () => undefined
    } as any,
    createQQChannel: () => {
      throw new Error("QQ should not be constructed in this test");
    },
    logger: {
      info() {},
      warn() {},
      error() {}
    } as any,
    pet: {
      emitEvent() {}
    } as any,
    getQQConfig: () => ({ enabled: false, appId: "", appSecret: "" }),
    handleTelegram: async () => "ok",
    handleQQ: async () => "ok",
    handleFeishu: async (payload) => {
      seenPayload = payload as Record<string, unknown>;
      return "ok";
    },
    onRecordUserActivity: async () => undefined,
    onAssistantMessage: async () => undefined,
    emitStatus: async () => undefined,
    withTimeout: async (promise) => promise,
    chatReplyTimeoutMs: 5000,
    resourceId: "primary-user",
    threadId: "primary-thread"
  });

  await coordinator.startFeishu();
  assert.ok(feishuInboundHandler);
  const runFeishuInbound = feishuInboundHandler as (message: any) => Promise<void>;

  const attachments = [
    {
      id: "attachment-2",
      kind: "image",
      filename: "photo.png",
      mimeType: "image/png",
      size: 12,
      path: "/tmp/photo.png",
      source: "user-upload",
      createdAt: new Date().toISOString()
    }
  ];

  await runFeishuInbound({
    kind: "photo",
    chatId: "chat-1",
    text: "",
    fromUserId: "user-1",
    sentAt: new Date().toISOString(),
    attachments
  });

  assert.deepEqual((seenPayload as { attachments?: unknown[] } | null)?.attachments, attachments);
});

test("ChannelRouter forwards inbound attachments for Telegram, QQ, and Feishu", async () => {
  const seenInputs: Array<Record<string, unknown>> = [];
  const router = new ChannelRouter({
    reply: async (input: Record<string, unknown>) => {
      seenInputs.push(input);
      return "ok";
    }
  } as any);

  const attachments = [
    {
      id: "attachment-3",
      kind: "image",
      filename: "photo.png",
      mimeType: "image/png",
      size: 12,
      path: "/tmp/photo.png",
      source: "user-upload",
      createdAt: new Date().toISOString()
    }
  ];

  await (router as any).handleTelegram({
    text: "图一",
    attachments,
    resourceId: "primary-user",
    threadId: "primary-thread"
  });
  await (router as any).handleQQ({
    text: "图二",
    attachments,
    resourceId: "primary-user",
    threadId: "primary-thread"
  });
  await (router as any).handleFeishu({
    text: "图三",
    attachments,
    resourceId: "primary-user",
    threadId: "primary-thread"
  });

  assert.equal(seenInputs.length, 3);
  assert.deepEqual(seenInputs[0]?.attachments, attachments);
  assert.deepEqual(seenInputs[1]?.attachments, attachments);
  assert.deepEqual(seenInputs[2]?.attachments, attachments);
});
