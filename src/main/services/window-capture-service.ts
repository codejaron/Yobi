import { captureWindowWithMacHelper } from "./macos-capture-helper";
import { captureWindowWithNodeScreenshots } from "./node-screenshots-capture";

export interface WindowCaptureInput {
  appName?: string;
}

export interface WindowCaptureResult {
  pngBuffer: Buffer;
  appName: string;
  title: string;
  focused: boolean;
}

export interface WindowCaptureServiceDeps {
  platform?: NodeJS.Platform;
  captureWithMacHelper?: (input: WindowCaptureInput) => Promise<WindowCaptureResult | null>;
  captureWithNodeScreenshots?: (input: WindowCaptureInput) => Promise<WindowCaptureResult | null>;
}

export function shouldUseMacCaptureHelper(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

export async function captureWindowImage(
  input: WindowCaptureInput,
  deps: WindowCaptureServiceDeps = {}
): Promise<WindowCaptureResult | null> {
  if (shouldUseMacCaptureHelper(deps.platform ?? process.platform)) {
    return (deps.captureWithMacHelper ?? captureWindowWithMacHelper)(input);
  }

  return (deps.captureWithNodeScreenshots ?? captureWindowWithNodeScreenshots)(input);
}
