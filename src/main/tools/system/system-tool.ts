import os from "node:os";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
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

type CaptureTarget = Record<string, unknown> & {
  captureImageSync?: () => unknown;
  captureImage?: () => Promise<unknown>;
};

type WindowTarget = CaptureTarget & {
  appName?: () => string;
  title?: () => string;
  isFocused?: () => boolean;
  z?: () => number;
};

type ScreenshotsModule = Record<string, unknown> & {
  Window?: {
    all?: () => WindowTarget[];
  };
};

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function readWindowAppName(target: WindowTarget): string {
  if (typeof target.appName !== "function") {
    return "";
  }

  try {
    return String(target.appName() ?? "").trim();
  } catch {
    return "";
  }
}

function readWindowTitle(target: WindowTarget): string {
  if (typeof target.title !== "function") {
    return "";
  }

  try {
    return String(target.title() ?? "").trim();
  } catch {
    return "";
  }
}

function readWindowFocused(target: WindowTarget): boolean {
  if (typeof target.isFocused !== "function") {
    return false;
  }

  try {
    return Boolean(target.isFocused());
  } catch {
    return false;
  }
}

function readWindowZ(target: WindowTarget): number {
  if (typeof target.z !== "function") {
    return Number.POSITIVE_INFINITY;
  }

  try {
    const z = Number(target.z());
    return Number.isFinite(z) ? z : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

async function normalizeCapturedImage(image: unknown): Promise<Buffer | null> {
  if (!image) {
    return null;
  }

  if (Buffer.isBuffer(image)) {
    return image;
  }

  if (typeof image === "object") {
    const candidate = image as Record<string, unknown>;
    const toPngSync = candidate.toPngSync;
    if (typeof toPngSync === "function") {
      return Buffer.from(toPngSync.call(candidate));
    }

    const toPng = candidate.toPng;
    if (typeof toPng === "function") {
      return Buffer.from(await toPng.call(candidate));
    }
  }

  return null;
}

async function captureTargetImage(target: CaptureTarget): Promise<Buffer | null> {
  const image =
    (typeof target.captureImageSync === "function" && target.captureImageSync()) ||
    (typeof target.captureImage === "function" && (await target.captureImage()));

  return normalizeCapturedImage(image);
}

async function loadScreenshotsModule(): Promise<ScreenshotsModule | null> {
  try {
    const imported = (await import("node-screenshots")) as Record<string, unknown>;
    return (imported.default ?? imported) as ScreenshotsModule;
  } catch {
    return null;
  }
}

function selectWindowTarget(windows: WindowTarget[], appName?: string): WindowTarget {
  const requestedApp = normalizeText(appName);
  const filtered =
    requestedApp.length === 0
      ? windows
      : windows.filter((item) => {
          const current = normalizeText(readWindowAppName(item));
          return current === requestedApp || current.includes(requestedApp);
        });

  if (filtered.length === 0) {
    const knownApps = Array.from(
      new Set(
        windows
          .map((item) => readWindowAppName(item))
          .filter((item) => item.length > 0)
      )
    )
      .slice(0, 12)
      .join(", ");
    const suffix = knownApps ? ` 可用应用: ${knownApps}` : "";
    throw new Error(`未找到应用窗口: ${appName ?? "(empty appName)"}。${suffix}`);
  }

  const focused = filtered.find((item) => readWindowFocused(item));
  if (focused) {
    return focused;
  }

  return filtered.slice().sort((a, b) => readWindowZ(a) - readWindowZ(b))[0];
}

async function saveSystemScreenshot(buffer: Buffer): Promise<string> {
  const outputDir = path.join(os.homedir(), ".yobi", "tool-media");
  await mkdir(outputDir, { recursive: true });
  const file = path.join(outputDir, `system-${Date.now()}.png`);
  await writeFile(file, buffer);
  return file;
}

async function captureAppScreenshot(appName?: string): Promise<{
  path: string;
  appName: string;
  title: string;
  focused: boolean;
}> {
  const screenshots = await loadScreenshotsModule();
  if (!screenshots) {
    throw new Error("加载 node-screenshots 失败。请确认依赖与系统权限。");
  }

  const windows = screenshots.Window?.all?.() ?? [];
  if (windows.length === 0) {
    throw new Error("未检测到可截图窗口。");
  }

  const target = selectWindowTarget(windows, appName);
  const image = await captureTargetImage(target);
  if (!image) {
    throw new Error("窗口截图失败，未获取到图像数据。");
  }

  const filePath = await saveSystemScreenshot(image);
  return {
    path: filePath,
    appName: readWindowAppName(target),
    title: readWindowTitle(target),
    focused: readWindowFocused(target)
  };
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
    source: "builtin",
    description: "执行受控 shell 命令，或操控本机 App（open/type/press/notify/screenshot）。",
    parameters: systemParamsSchema,
    isEnabled: (config) => config.tools.system.enabled,
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
        const captured = await captureAppScreenshot(params.appName);
        return {
          success: true,
          data: captured,
          media: [
            {
              type: "image",
              path: captured.path,
              mimeType: "image/png"
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
