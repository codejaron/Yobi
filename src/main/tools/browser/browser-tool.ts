import { z } from "zod";
import type { AppConfig } from "@shared/types";
import { supportsChatToolResultMedia } from "@main/core/provider-utils";
import { ChatMediaStore } from "@main/services/chat-media";
import { SandboxGuard } from "@main/tools/guard/sandbox";
import type { ToolDefinition, ToolResult } from "@main/tools/types";
import { BrowserController, type BrowserAction } from "./controller";

const browserParamsSchema = z.object({
  action: z.enum([
    "start",
    "stop",
    "navigate",
    "snapshot",
    "screenshot",
    "act",
    "tabs",
    "open",
    "close"
  ]).describe("浏览器操作类型。"),
  url: z.string().optional().describe("navigate 或 open 时访问的 URL。"),
  actKind: z.enum(["click", "type", "press", "hover", "select", "scroll"]).optional().describe("action=act 时的具体页面交互类型。"),
  ref: z.number().int().positive().optional().describe("页面快照中元素的 ref 编号。"),
  text: z.string().optional().describe("type 动作时输入的文本。"),
  key: z.string().optional().describe("press 动作时按下的按键名称。"),
  option: z.string().optional().describe("select 动作时选择的 option 值。"),
  deltaY: z.number().optional().describe("scroll 动作时的纵向滚动距离。"),
  tabId: z.number().int().min(0).optional().describe("close 动作时要关闭的标签页 ID。"),
  fullPage: z.boolean().optional().describe("screenshot 时是否截取整页。"),
  append: z.boolean().optional().describe("type 动作时是否追加到现有输入，而不是清空重输。")
});

type BrowserParams = z.infer<typeof browserParamsSchema>;

interface BrowserToolDeps {
  controller: BrowserController;
  sandboxGuard: SandboxGuard;
  getConfig: () => AppConfig;
  chatMediaStore: ChatMediaStore;
}

function controllerConfig(config: AppConfig) {
  return {
    headless: config.tools.browser.headless,
    cdpPort: config.tools.browser.cdpPort
  };
}

function toBrowserModelOutput(getConfig: () => AppConfig, result: ToolResult) {
  if (!result.success) {
    return {
      type: "error-text" as const,
      value: result.error?.trim() || "浏览器截图失败"
    };
  }

  const media = result.media?.find((item) => item.type === "image");
  if (!media) {
    return typeof result.data === "string"
      ? {
          type: "text" as const,
          value: result.data
        }
      : {
          type: "json" as const,
          value: (result.data ?? null) as any
        };
  }

  const pathText =
    typeof (result.data as { path?: unknown } | undefined)?.path === "string"
      ? String((result.data as { path?: string }).path)
      : media?.path;
  const fallbackText = pathText ? `已截取浏览器截图，路径：${pathText}` : "已截取浏览器截图。";
  if (!media?.dataBase64 || !supportsChatToolResultMedia(getConfig())) {
    return {
      type: "text" as const,
      value: fallbackText
    };
  }

  return {
    type: "content" as const,
    value: [
      {
        type: "text" as const,
        text: fallbackText
      },
      {
        type: "media" as const,
        data: media.dataBase64,
        mediaType: media.mimeType
      }
    ]
  };
}

function buildAction(params: BrowserParams): BrowserAction {
  if (!params.actKind) {
    throw new Error("act 请求缺少 actKind");
  }

  if (params.actKind === "scroll") {
    return {
      kind: "scroll",
      deltaY: params.deltaY
    };
  }

  if (params.actKind === "press") {
    if (!params.key) {
      throw new Error("press 动作需要 key");
    }

    return {
      kind: "press",
      key: params.key,
      ref: params.ref
    };
  }

  if (!params.ref) {
    throw new Error(`${params.actKind} 动作需要 ref`);
  }

  if (params.actKind === "click") {
    return {
      kind: "click",
      ref: params.ref
    };
  }

  if (params.actKind === "hover") {
    return {
      kind: "hover",
      ref: params.ref
    };
  }

  if (params.actKind === "type") {
    if (typeof params.text !== "string") {
      throw new Error("type 动作需要 text");
    }

    return {
      kind: "type",
      ref: params.ref,
      text: params.text,
      append: params.append
    };
  }

  if (!params.option) {
    throw new Error("select 动作需要 option");
  }

  return {
    kind: "select",
    ref: params.ref,
    option: params.option
  };
}

export function createBrowserTool(deps: BrowserToolDeps): ToolDefinition<BrowserParams> {
  return {
    name: "browser",
    source: "builtin",
    description:
      "操控 Yobi 隔离浏览器。支持打开网页、页面快照、基于 ref 的点击/输入/选择、截图和标签页管理。",
    parameters: browserParamsSchema,
    isEnabled: (config) => config.tools.browser.enabled,
    toModelOutput: (result) => toBrowserModelOutput(deps.getConfig, result),
    async execute(params): Promise<ToolResult> {
      const config = deps.getConfig();
      deps.sandboxGuard.ensureBrowserEnabled();

      if (params.action === "start") {
        await deps.controller.start(controllerConfig(config));
        return {
          success: true,
          data: {
            started: true,
            headless: config.tools.browser.headless,
            cdpPort: config.tools.browser.cdpPort
          }
        };
      }

      if (params.action === "stop") {
        await deps.controller.stop();
        return {
          success: true,
          data: {
            stopped: true
          }
        };
      }

      if (params.action === "navigate") {
        if (!params.url) {
          throw new Error("navigate 需要 url");
        }

        deps.sandboxGuard.ensureBrowserUrlAllowed(params.url);
        await deps.controller.start(controllerConfig(config));
        const result = await deps.controller.navigate(params.url);
        return {
          success: true,
          data: result
        };
      }

      if (params.action === "open") {
        await deps.controller.start(controllerConfig(config));
        if (params.url) {
          deps.sandboxGuard.ensureBrowserUrlAllowed(params.url);
        }

        const result = await deps.controller.open(params.url);
        return {
          success: true,
          data: result
        };
      }

      if (params.action === "snapshot") {
        await deps.controller.start(controllerConfig(config));
        const snapshot = await deps.controller.snapshot();
        return {
          success: true,
          data: snapshot
        };
      }

      if (params.action === "act") {
        await deps.controller.start(controllerConfig(config));
        const action = buildAction(params);
        const result = await deps.controller.act(action);
        return {
          success: true,
          data: result
        };
      }

      if (params.action === "screenshot") {
        await deps.controller.start(controllerConfig(config));
        const image = await deps.controller.screenshot({
          fullPage: params.fullPage
        });
        const attachment = await deps.chatMediaStore.storeToolMedia({
          mediaType: "image/png",
          data: image,
          prefix: "browser",
          filename: "browser-screenshot.png"
        });

        return {
          success: true,
          data: {
            path: attachment.path
          },
          media: [
            {
              type: "image",
              path: attachment.path,
              mimeType: attachment.mimeType,
              filename: attachment.filename,
              dataBase64: image.toString("base64")
            }
          ]
        };
      }

      if (params.action === "tabs") {
        await deps.controller.start(controllerConfig(config));
        const tabs = await deps.controller.tabs();
        return {
          success: true,
          data: tabs
        };
      }

      await deps.controller.start(controllerConfig(config));
      const closed = await deps.controller.close(params.tabId);
      return {
        success: true,
        data: closed
      };
    },
    async dispose() {
      await deps.controller.stop();
    }
  };
}
