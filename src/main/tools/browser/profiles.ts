import os from "node:os";
import path from "node:path";

export function getDefaultBrowserProfileDir(): string {
  return path.join(os.homedir(), ".yobi", "browser-profile");
}
