import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveMacCaptureHelperPath } from "./macos-capture-helper-path";
import type { WindowCaptureInput, WindowCaptureResult } from "./window-capture-service";

const execFileAsync = promisify(execFile);

interface MacCaptureHelperOutput {
  pngBase64?: unknown;
  appName?: unknown;
  title?: unknown;
  focused?: unknown;
}

function normalizeOutput(raw: string): WindowCaptureResult {
  let parsed: MacCaptureHelperOutput;

  try {
    parsed = JSON.parse(raw) as MacCaptureHelperOutput;
  } catch (error) {
    throw new Error(`mac capture helper 返回了无效 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (typeof parsed.pngBase64 !== "string" || parsed.pngBase64.length === 0) {
    throw new Error("mac capture helper 未返回截图数据。");
  }

  return {
    pngBuffer: Buffer.from(parsed.pngBase64, "base64"),
    appName: typeof parsed.appName === "string" ? parsed.appName : "",
    title: typeof parsed.title === "string" ? parsed.title : "",
    focused: Boolean(parsed.focused)
  };
}

export async function captureWindowWithMacHelper(
  input: WindowCaptureInput
): Promise<WindowCaptureResult | null> {
  const helperPath = await resolveMacCaptureHelperPath();
  const args = ["capture-window", "--json"];
  if (input.appName?.trim()) {
    args.push("--app-name", input.appName.trim());
  }

  try {
    const { stdout } = await execFileAsync(helperPath, args, {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 32 * 1024 * 1024
    });
    return normalizeOutput(stdout.trim());
  } catch (error) {
    if (error && typeof error === "object" && "stderr" in error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
      if (stderr) {
        throw new Error(stderr);
      }
    }
    throw error;
  }
}
