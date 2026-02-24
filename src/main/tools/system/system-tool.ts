import os from "node:os";
import { z } from "zod";
import type { AppConfig } from "@shared/types";
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
  ]),
  command: z.string().optional(),
  appName: z.string().optional(),
  text: z.string().optional(),
  keys: z.array(z.string()).optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(60_000).optional()
});

type SystemParams = z.infer<typeof systemParamsSchema>;

interface SystemToolDeps {
  getConfig: () => AppConfig;
  sandboxGuard: SandboxGuard;
}

function ensureSystemEnabled(config: AppConfig): void {
  if (!config.tools.system.enabled) {
    throw new Error("系统操控工具未启用，请先在设置中开启。");
  }
}

export function createSystemTool(deps: SystemToolDeps): ToolDefinition<SystemParams> {
  const shellExecutor = new ShellExecutor(deps.sandboxGuard);
  const macAdapter = new MacOSAdapter();
  const windowsAdapter = new WindowsAdapter();

  return {
    name: "system",
    description: "执行受控 shell 命令，或操控本机 App（open/type/press/notify）。",
    parameters: systemParamsSchema,
    requiresApproval(params) {
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
        throw new Error("screenshot_app 还未实现。");
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
    await adapter.typeText();
    return {
      success: true,
      data: {
        typed: true
      }
    };
  }

  if (params.action === "press_keys") {
    await adapter.pressKeys();
    return {
      success: true,
      data: {
        pressed: params.keys ?? []
      }
    };
  }

  if (params.action === "get_windows") {
    const windows = await adapter.getAppWindows();
    return {
      success: true,
      data: windows
    };
  }

  throw new Error(`Windows adapter 不支持 action: ${params.action}`);
}
