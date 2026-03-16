import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, type AppConfig } from "@shared/types";
import { createBrowserTool } from "@main/tools/browser/browser-tool";
import { createSystemTool } from "@main/tools/system/system-tool";

function cloneConfig(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function createToolResult() {
  return {
    success: true as const,
    data: {
      path: "/tmp/capture.png"
    },
    media: [
      {
        type: "image" as const,
        path: "/tmp/capture.png",
        mimeType: "image/png",
        filename: "capture.png",
        dataBase64: "ZmFrZS1pbWFnZQ=="
      }
    ]
  };
}

test("browser screenshot toModelOutput returns content with media when provider supports tool-result media", () => {
  const config = cloneConfig();
  const tool = createBrowserTool({
    controller: {} as any,
    sandboxGuard: {} as any,
    getConfig: () => config,
    chatMediaStore: {} as any
  });

  const output = tool.toModelOutput?.(createToolResult());

  assert.deepEqual(output, {
    type: "content",
    value: [
      {
        type: "text",
        text: "已截取浏览器截图，路径：/tmp/capture.png"
      },
      {
        type: "media",
        data: "ZmFrZS1pbWFnZQ==",
        mediaType: "image/png"
      }
    ]
  });
});

test("system screenshot toModelOutput falls back to text when provider does not support tool-result media", () => {
  const config = cloneConfig();
  config.modelRouting.chat.providerId = "openai-main";
  config.providers[0] = {
    ...config.providers[0],
    id: "openai-main",
    kind: "openai",
    apiMode: "chat"
  };

  const tool = createSystemTool({
    getConfig: () => config,
    sandboxGuard: {} as any,
    chatMediaStore: {} as any
  });

  const output = tool.toModelOutput?.(createToolResult());

  assert.deepEqual(output, {
    type: "text",
    value: "已截取应用窗口截图，路径：/tmp/capture.png"
  });
});
