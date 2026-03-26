import os from "node:os";
import { z } from "zod";
import type { AppConfig } from "@shared/types";
import { supportsChatToolResultMedia } from "@main/core/provider-utils";
import { ChatMediaStore } from "@main/services/chat-media";
import { captureWindowImage } from "@main/services/window-capture-service";
import { SandboxGuard } from "@main/tools/guard/sandbox";
import type { ToolDefinition, ToolResult } from "@main/tools/types";
import { ShellExecutor } from "./exec";
import { MacOSAdapter } from "./macos-adapter";
import { WindowsAdapter } from "./win-adapter";

const systemParamsSchema = z.object({
  action: z.enum([
    "exec",
    "open_app",
    "type_text",
    "press_keys",
    "notify",
    "get_windows",
    "screenshot_app"
  ]).describe("系统操作类型。"),
  command: z.string().optional().describe("action=exec 时要执行的 shell 命令。"),
  appName: z.string().optional().describe("目标应用名。用于 open_app、get_windows，或作为 screenshot_app 的截图目标。"),
  text: z.string().optional().describe("type_text 时要输入的文本。"),
  keys: z.array(z.string()).optional().describe("press_keys 时要按下的按键列表。"),
  title: z.string().optional().describe("notify 时通知标题。"),
  body: z.string().optional().describe("notify 时通知正文。"),
  cwd: z.string().optional().describe("exec 时命令执行目录。"),
  timeoutMs: z.number().int().positive().max(60_000).optional().describe("exec 时超时时间，毫秒。")
});

type SystemParams = z.infer<typeof systemParamsSchema>;

interface SystemToolDeps {
  getConfig: () => AppConfig;
  sandboxGuard: SandboxGuard;
  chatMediaStore: ChatMediaStore;
}

async function captureAppScreenshot(
  chatMediaStore: ChatMediaStore,
  appName?: string
): Promise<{
  attachment: Awaited<ReturnType<ChatMediaStore["storeToolMedia"]>>;
  imageBase64: string;
  appName: string;
  title: string;
  focused: boolean;
}> {
  const captured = await captureWindowImage({
    appName
  });
  if (!captured) {
    throw new Error("窗口截图失败，未获取到图像数据。");
  }

  const attachment = await chatMediaStore.storeToolMedia({
    mediaType: "image/png",
    data: captured.pngBuffer,
    prefix: "system",
    filename: "system-screenshot.png"
  });
  return {
    attachment,
    imageBase64: captured.pngBuffer.toString("base64"),
    appName: captured.appName,
    title: captured.title,
    focused: captured.focused
  };
}

function ensureSystemEnabled(config: AppConfig): void {
  if (!config.tools.system.enabled) {
    throw new Error("系统操控工具未启用，请先在设置中开启。");
  }
}

function toSystemModelOutput(getConfig: () => AppConfig, result: ToolResult) {
  if (!result.success) {
    return {
      type: "error-text" as const,
      value: result.error?.trim() || "应用截图失败"
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
  const fallbackText = pathText ? `已截取应用窗口截图，路径：${pathText}` : "已截取应用窗口截图。";
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

export function createSystemTool(deps: SystemToolDeps): ToolDefinition<SystemParams> {
  const shellExecutor = new ShellExecutor(deps.sandboxGuard);
  const macAdapter = new MacOSAdapter();
  const windowsAdapter = new WindowsAdapter();

  return {
    name: "system",
    source: "builtin",
    description: "执行受控系统操作。支持 shell 命令、本机应用打开、文本输入、快捷键、通知、窗口查询和应用截图。",
    parameters: systemParamsSchema,
    isEnabled: (config) => config.tools.system.enabled,
    toModelOutput: (result) => toSystemModelOutput(deps.getConfig, result),
    requiresApproval(params, config) {
      if (!config.tools.system.approvalRequired) {
        return false;
      }

      return params.action !== "notify" && params.action !== "get_windows";
    },
    approvalText(params) {
      if (params.action === "exec") {
        return `执行命令:\n${params.command ?? "(empty)"}`;
      }

      if (params.action === "open_app") {
        return `打开应用: ${params.appName ?? "(missing appName)"}`;
      }

      if (params.action === "type_text") {
        return `向当前应用输入文本:\n${params.text ?? ""}`;
      }

      if (params.action === "press_keys") {
        return `发送快捷键: ${(params.keys ?? []).join(" + ")}`;
      }

      if (params.action === "screenshot_app") {
        return `截取应用窗口截图: ${params.appName ?? "当前前台窗口"}`;
      }

      return `执行系统操作: ${params.action}`;
    },
    async execute(params): Promise<ToolResult> {
      const config = deps.getConfig();
      ensureSystemEnabled(config);

      if (params.action === "exec") {
        if (!params.command) {
          throw new Error("exec 需要 command");
        }

        const result = await shellExecutor.run(params.command, {
          cwd: params.cwd,
          timeoutMs: params.timeoutMs
        });

        return {
          success: true,
          data: result
        };
      }

      if (params.action === "notify") {
        const title = params.title ?? "Yobi";
        const body = params.body ?? params.text ?? "";

        if (process.platform === "darwin") {
          await macAdapter.notify(title, body);
        } else if (process.platform === "win32") {
          await windowsAdapter.notify(title, body);
        } else {
          throw new Error(`当前平台暂不支持通知: ${os.platform()}`);
        }

        return {
          success: true,
          data: {
            notified: true,
            title
          }
        };
      }

      if (params.action === "screenshot_app") {
        const captured = await captureAppScreenshot(deps.chatMediaStore, params.appName);
        return {
          success: true,
          data: {
            path: captured.attachment.path,
            appName: captured.appName,
            title: captured.title,
            focused: captured.focused
          },
          media: [
            {
              type: "image",
              path: captured.attachment.path,
              mimeType: captured.attachment.mimeType,
              filename: captured.attachment.filename,
              dataBase64: captured.imageBase64
            }
          ]
        };
      }

      if (!params.appName && (params.action === "open_app" || params.action === "get_windows")) {
        throw new Error(`${params.action} 需要 appName`);
      }

      if (process.platform === "darwin") {
        return executeWithMacAdapter(macAdapter, params);
      }

      if (process.platform === "win32") {
        return executeWithWindowsAdapter(windowsAdapter, params);
      }

      throw new Error(`当前平台暂不支持该系统操作: ${os.platform()}`);
    }
  };
}

async function executeWithMacAdapter(
  adapter: MacOSAdapter,
  params: SystemParams
): Promise<ToolResult> {
  if (params.action === "open_app") {
    await adapter.openApp(params.appName ?? "");
    return {
      success: true,
      data: {
        opened: params.appName
      }
    };
  }

  if (params.action === "type_text") {
    if (typeof params.text !== "string") {
      throw new Error("type_text 需要 text");
    }

    await adapter.typeText(params.text);
    return {
      success: true,
      data: {
        typed: true,
        length: params.text.length
      }
    };
  }

  if (params.action === "press_keys") {
    const keys = params.keys ?? [];
    if (keys.length === 0) {
      throw new Error("press_keys 需要 keys");
    }

    await adapter.pressKeys(keys);
    return {
      success: true,
      data: {
        pressed: keys
      }
    };
  }

  if (params.action === "get_windows") {
    const windows = await adapter.getAppWindows(params.appName ?? "");
    return {
      success: true,
      data: windows
    };
  }

  throw new Error(`macOS adapter 不支持 action: ${params.action}`);
}

async function executeWithWindowsAdapter(
  adapter: WindowsAdapter,
  params: SystemParams
): Promise<ToolResult> {
  if (params.action === "open_app") {
    await adapter.openApp(params.appName ?? "");
    return {
      success: true,
      data: {
        opened: params.appName
      }
    };
  }

  if (params.action === "type_text") {
    if (typeof params.text !== "string") {
      throw new Error("type_text 需要 text");
    }

    await adapter.typeText(params.text);
    return {
      success: true,
      data: {
        typed: true,
        length: params.text.length
      }
    };
  }

  if (params.action === "press_keys") {
    const keys = params.keys ?? [];
    if (keys.length === 0) {
      throw new Error("press_keys 需要 keys");
    }

    await adapter.pressKeys(keys);
    return {
      success: true,
      data: {
        pressed: keys
      }
    };
  }

  if (params.action === "get_windows") {
    const windows = await adapter.getAppWindows(params.appName ?? "");
    return {
      success: true,
      data: windows
    };
  }

  throw new Error(`Windows adapter 不支持 action: ${params.action}`);
}
