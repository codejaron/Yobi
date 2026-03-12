import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, DEFAULT_KERNEL_STATE, DEFAULT_USER_PROFILE, type AppConfig } from "@shared/types";
import { ConversationEngine } from "../core/conversation.js";

function cloneConfig(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

test("ConversationEngine: hidden scheduled prompt is not persisted but is sent to the model", async () => {
  const config = cloneConfig();
  const remembered: Array<{ role: string; text: string; metadata?: Record<string, unknown> }> = [];
  let seenMessages: Array<{ role: string; content: string }> = [];
  let seenAllowedToolNames: string[] | undefined;

  const conversation = new ConversationEngine(
    {
      rememberMessage: async (input: { role: string; text: string; metadata?: Record<string, unknown> }) => {
        remembered.push(input);
      },
      getProfile: async () => DEFAULT_USER_PROFILE,
      listFacts: async () => [],
      listRecentEpisodes: async () => [],
      searchRelevantFacts: async () => [],
      touchFacts: async () => undefined,
      listRecentBufferMessages: async () => [],
      mapRecentToModelMessages: async () => []
    } as any,
    {
      getChatModel: () => ({})
    } as any,
    {
      getToolSet: (input: { allowedToolNames?: string[] }) => {
        seenAllowedToolNames = input.allowedToolNames;
        return {};
      }
    } as any,
    {
      getCatalogPrompt: () => ({
        prompt: "",
        summary: {
          enabledCount: 0,
          truncated: false,
          truncatedDescriptions: 0,
          omittedSkills: 0
        }
      })
    } as any,
    {
      getSnapshot: () => DEFAULT_KERNEL_STATE
    } as any,
    {
      soulPath: "/tmp/does-not-exist"
    } as any,
    () => config,
    undefined,
    ((input: { messages: Array<{ role: string; content: string }> }) => {
      seenMessages = input.messages;
      return {
        fullStream: (async function* () {
          yield {
            type: "text-delta",
            text: "自动报告"
          };
        })(),
        totalUsage: Promise.resolve(undefined)
      };
    }) as any
  );

  const reply = await conversation.reply({
    text: "搜索 GitHub Trending 前十，并总结给我。",
    channel: "console",
    resourceId: "resource-1",
    threadId: "thread-1",
    persistUserMessage: false,
    allowedToolNames: ["web_search", "web_fetch"]
  });

  assert.equal(reply, "自动报告");
  assert.deepEqual(
    remembered.map((item) => item.role),
    ["assistant"]
  );
  assert.equal(remembered[0]?.text, "自动报告");
  assert.equal(seenMessages.at(-1)?.role, "user");
  assert.equal(seenMessages.at(-1)?.content, "搜索 GitHub Trending 前十，并总结给我。");
  assert.deepEqual(seenAllowedToolNames, ["web_search", "web_fetch"]);
});

test("ConversationEngine: surfaces stream error chunks instead of falling back to empty-reply copy", async () => {
  const config = cloneConfig();
  const remembered: Array<{ role: string; text: string; metadata?: Record<string, unknown> }> = [];

  const conversation = new ConversationEngine(
    {
      rememberMessage: async (input: { role: string; text: string; metadata?: Record<string, unknown> }) => {
        remembered.push(input);
      },
      getProfile: async () => DEFAULT_USER_PROFILE,
      listFacts: async () => [],
      listRecentEpisodes: async () => [],
      searchRelevantFacts: async () => [],
      touchFacts: async () => undefined,
      listRecentBufferMessages: async () => [],
      mapRecentToModelMessages: async () => []
    } as any,
    {
      getChatModel: () => ({})
    } as any,
    {
      getToolSet: () => ({})
    } as any,
    {
      getCatalogPrompt: () => ({
        prompt: "",
        summary: {
          enabledCount: 0,
          truncated: false,
          truncatedDescriptions: 0,
          omittedSkills: 0
        }
      })
    } as any,
    {
      getSnapshot: () => DEFAULT_KERNEL_STATE
    } as any,
    {
      soulPath: "/tmp/does-not-exist"
    } as any,
    () => config,
    undefined,
    (() => ({
      fullStream: (async function* () {
        yield {
          type: "error",
          error: new Error("OpenAI 401 invalid_api_key")
        };
      })(),
      totalUsage: Promise.resolve(undefined)
    })) as any
  );

  await assert.rejects(
    () =>
      conversation.reply({
        text: "你好",
        channel: "console",
        resourceId: "resource-1",
        threadId: "thread-1",
        persistUserMessage: false
      }),
    /OpenAI 401 invalid_api_key/
  );
  assert.deepEqual(remembered, []);
});

test("ConversationEngine: treats finishReason=error as a real failure when no reply text is produced", async () => {
  const config = cloneConfig();

  const conversation = new ConversationEngine(
    {
      rememberMessage: async () => undefined,
      getProfile: async () => DEFAULT_USER_PROFILE,
      listFacts: async () => [],
      listRecentEpisodes: async () => [],
      searchRelevantFacts: async () => [],
      touchFacts: async () => undefined,
      listRecentBufferMessages: async () => [],
      mapRecentToModelMessages: async () => []
    } as any,
    {
      getChatModel: () => ({})
    } as any,
    {
      getToolSet: () => ({})
    } as any,
    {
      getCatalogPrompt: () => ({
        prompt: "",
        summary: {
          enabledCount: 0,
          truncated: false,
          truncatedDescriptions: 0,
          omittedSkills: 0
        }
      })
    } as any,
    {
      getSnapshot: () => DEFAULT_KERNEL_STATE
    } as any,
    {
      soulPath: "/tmp/does-not-exist"
    } as any,
    () => config,
    undefined,
    (() => ({
      fullStream: (async function* () {
        yield {
          type: "finish",
          finishReason: "error",
          totalUsage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0
          }
        };
      })(),
      totalUsage: Promise.resolve(undefined)
    })) as any
  );

  await assert.rejects(
    () =>
      conversation.reply({
        text: "你好",
        channel: "console",
        resourceId: "resource-1",
        threadId: "thread-1",
        persistUserMessage: false
      }),
    /LLM 调用失败/
  );
});
