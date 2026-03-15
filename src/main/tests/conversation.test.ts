import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  DEFAULT_KERNEL_STATE,
  DEFAULT_USER_PROFILE,
  type AppConfig,
  type RealtimeEmotionalSignals
} from "@shared/types";
import { ConversationEngine } from "../core/conversation.js";

function cloneConfig(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function assertSingleToolTrace(
  toolTrace: unknown,
  expected: {
    toolName: string;
    status: string;
    inputPreview: string;
  }
) {
  const items = (toolTrace as { items?: Array<Record<string, unknown>> } | undefined)?.items;

  assert.ok(Array.isArray(items));
  assert.equal(items.length, 1);
  assert.equal(items[0]?.toolName, expected.toolName);
  assert.equal(items[0]?.status, expected.status);
  assert.equal(items[0]?.inputPreview, expected.inputPreview);

  if (typeof items[0]?.durationMs !== "undefined") {
    assert.equal(typeof items[0]?.durationMs, "number");
    assert.ok((items[0]?.durationMs as number) > 0);
  }
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

test("ConversationEngine: persists toolTrace metadata for successful tool calls", async () => {
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
          type: "tool-call",
          toolCallId: "tool-1",
          toolName: "search_web",
          input: { query: "GitHub Trending" }
        };
        yield {
          type: "tool-result",
          toolCallId: "tool-1",
          toolName: "search_web",
          input: { query: "GitHub Trending" },
          output: {
            success: true,
            data: { total: 3 }
          }
        };
        yield {
          type: "text-delta",
          text: "整理好了"
        };
      })(),
      totalUsage: Promise.resolve(undefined)
    })) as any
  );

  const reply = await conversation.reply({
    text: "帮我搜索一下",
    channel: "console",
    resourceId: "resource-1",
    threadId: "thread-1",
    persistUserMessage: false
  });

  assert.equal(reply, "整理好了");
  assertSingleToolTrace(remembered[0]?.metadata?.toolTrace, {
    toolName: "search_web",
    status: "success",
    inputPreview: "搜索：GitHub Trending"
  });
  const assistantTimeline = remembered[0]?.metadata?.assistantTimeline as
    | { blocks?: Array<Record<string, unknown>> }
    | undefined;
  const firstTool = assistantTimeline?.blocks?.[0]?.tool as Record<string, unknown> | undefined;
  assert.equal(assistantTimeline?.blocks?.[0]?.type, "tool");
  assert.equal(firstTool?.toolName, "search_web");
  assert.equal(firstTool?.status, "success");
  assert.equal(firstTool?.inputPreview, "搜索：GitHub Trending");
  if (typeof firstTool?.durationMs !== "undefined") {
    assert.equal(typeof firstTool.durationMs, "number");
  }
  assert.deepEqual(assistantTimeline?.blocks?.[1], {
    type: "text",
    text: "整理好了"
  });
});

test("ConversationEngine: persists voice recognition metadata and injects hidden voice context", async () => {
  const config = cloneConfig();
  const remembered: Array<{ role: string; text: string; metadata?: Record<string, unknown> }> = [];
  let seenSystem = "";

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
    ((input: { system: string }) => {
      seenSystem = input.system;
      return {
        fullStream: (async function* () {
          yield {
            type: "text-delta",
            text: "收到"
          };
        })(),
        totalUsage: Promise.resolve(undefined)
      };
    }) as any
  );

  await conversation.reply({
    text: "今天有点开心",
    channel: "console",
    resourceId: "resource-1",
    threadId: "thread-1",
    voiceContext: {
      provider: "sensevoice-local",
      metadata: {
        language: "zh",
        emotion: "happy",
        event: "speech",
        rawTags: ["zh", "HAPPY", "Speech"]
      }
    }
  });

  assert.equal(remembered[0]?.role, "user");
  assert.deepEqual(remembered[0]?.metadata?.speechRecognition, {
    provider: "sensevoice-local",
    language: "zh",
    emotion: "happy",
    event: "speech",
    rawTags: ["zh", "HAPPY", "Speech"]
  });
  assert.match(seenSystem, /\[VOICE INPUT CONTEXT\]/);
  assert.match(seenSystem, /language: zh/i);
  assert.match(seenSystem, /emotion: happy/i);
});

test("ConversationEngine: parses hidden signals from raw final text before visible stripping", async () => {
  const config = cloneConfig();
  let seenSignals: RealtimeEmotionalSignals | null = null;

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
    async (signals) => {
      seenSignals = signals;
    },
    (() => ({
      fullStream: (async function* () {
        yield {
          type: "text-delta",
          text: '收到<signals emotion_label="happy" intensity="0.8" engagement="0.8" trust_delta="0.1" />'
        };
      })(),
      totalUsage: Promise.resolve(undefined)
    })) as any
  );

  const reply = await conversation.reply({
    text: "试试看",
    channel: "console",
    resourceId: "resource-1",
    threadId: "thread-1",
    persistUserMessage: false
  });

  assert.equal(reply, "收到");
  assert.deepEqual(seenSignals, {
    emotion_label: "happy",
    intensity: 0.8,
    engagement: 0.8,
    trust_delta: 0.1
  });
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

test("ConversationEngine: persists aborted toolTrace when stream aborts mid-tool", async () => {
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
          type: "text-delta",
          text: "已经输出了一半"
        };
        yield {
          type: "tool-call",
          toolCallId: "tool-1",
          toolName: "web_fetch",
          input: { url: "https://example.com/page" }
        };
        yield {
          type: "abort"
        };
      })(),
      totalUsage: Promise.resolve(undefined)
    })) as any
  );

  await assert.rejects(
    () =>
      conversation.reply({
        text: "抓一下页面",
        channel: "console",
        resourceId: "resource-1",
        threadId: "thread-1",
        persistUserMessage: false
    }),
    /LLM 回复已中断/
  );

  assert.equal(remembered[0]?.text, "已经输出了一半");
  assertSingleToolTrace(remembered[0]?.metadata?.toolTrace, {
    toolName: "web_fetch",
    status: "aborted",
    inputPreview: "URL：https://example.com/page"
  });
});

test("ConversationEngine: persists tool-only aborted turn with empty text", async () => {
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
          type: "tool-call",
          toolCallId: "tool-1",
          toolName: "search_web",
          input: { query: "北京天气" }
        };
        yield {
          type: "abort"
        };
      })(),
      totalUsage: Promise.resolve(undefined)
    })) as any
  );

  await assert.rejects(
    () =>
      conversation.reply({
        text: "查天气",
        channel: "console",
        resourceId: "resource-1",
        threadId: "thread-1",
        persistUserMessage: false
      }),
    /LLM 回复已中断/
  );

  assert.equal(remembered[0]?.text, "");
  assertSingleToolTrace(remembered[0]?.metadata?.toolTrace, {
    toolName: "search_web",
    status: "aborted",
    inputPreview: "搜索：北京天气"
  });
});

test("ConversationEngine: resolves final reply without waiting for totalUsage", async () => {
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
          type: "text-delta",
          text: "很快返回"
        };
      })(),
      totalUsage: new Promise(() => undefined)
    })) as any
  );

  const reply = await Promise.race([
    conversation.reply({
      text: "你好",
      channel: "console",
      resourceId: "resource-1",
      threadId: "thread-1",
      persistUserMessage: false
    }),
    new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error("reply timed out")), 100);
    })
  ]);

  assert.equal(reply, "很快返回");
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
