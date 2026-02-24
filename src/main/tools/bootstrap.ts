import type { AppConfig } from "@shared/types";
import { BrowserController } from "./browser/controller";
import { createBrowserTool } from "./browser/browser-tool";
import { createFileTool } from "./file/file-tool";
import { ApprovalGuard } from "./guard/approval";
import { SandboxGuard } from "./guard/sandbox";
import { DefaultToolRegistry } from "./registry";
import { createSystemTool } from "./system/system-tool";

export function createDefaultToolRegistry(getConfig: () => AppConfig): DefaultToolRegistry {
  const approvalGuard = new ApprovalGuard(getConfig);
  const sandboxGuard = new SandboxGuard(getConfig);
  const registry = new DefaultToolRegistry(getConfig, approvalGuard);

  const browserController = new BrowserController();

  registry.register(
    createBrowserTool({
      controller: browserController,
      sandboxGuard,
      getConfig
    })
  );

  registry.register(
    createSystemTool({
      sandboxGuard,
      getConfig
    })
  );

  registry.register(
    createFileTool({
      sandboxGuard
    })
  );

  return registry;
}
