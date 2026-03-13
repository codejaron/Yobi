import type { BrowserWindowConstructorOptions } from "electron";

export function getMainWindowOptions(platform: NodeJS.Platform): BrowserWindowConstructorOptions {
  const options: BrowserWindowConstructorOptions = {
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 720,
    title: "Yobi Companion",
    backgroundColor: "#f5efe7"
  };

  if (platform === "darwin") {
    options.titleBarStyle = "hiddenInset";
  }

  return options;
}
