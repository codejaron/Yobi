import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { AppConfig } from "@shared/types";
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
  ]),
  url: z.string().optional(),
  actKind: z.enum(["click", "type", "press", "hover", "select", "scroll"]).optional(),
  ref: z.number().int().positive().optional(),
  text: z.string().optional(),
  key: z.string().optional(),
  option: z.string().optional(),
  deltaY: z.number().optional(),
  tabId: z.number().int().min(0).optional(),
  fullPage: z.boolean().optional(),
  append: z.boolean().optional()
});

type BrowserParams = z.infer<typeof browserParamsSchema>;

interface BrowserToolDeps {
  controller: BrowserController;
  sandboxGuard: SandboxGuard;
  getConfig: () => AppConfig;
}

function controllerConfig(config: AppConfig) {
  return {
    headless: config.tools.browser.headless,
    cdpPort: config.tools.browser.cdpPort
  };
}

async function saveScreenshot(buffer: Buffer): Promise<string> {
  const outputDir = path.join(os.homedir(), ".yobi", "tool-media");
  await mkdir(outputDir, { recursive: true });

  const file = path.join(outputDir, `browser-${Date.now()}.png`);
  await writeFile(file, buffer);
  return file;
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
      "操控 Yobi 隔离浏览器。支持打开网页、页面快照、基于 ref 点击/输入、截图与标签页管理。",
    parameters: browserParamsSchema,
    isEnabled: (config) => config.tools.browser.enabled,
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
        const filePath = await saveScreenshot(image);

        return {
          success: true,
          data: {
            path: filePath
          },
          media: [
            {
              type: "image",
              path: filePath,
              mimeType: "image/png"
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
