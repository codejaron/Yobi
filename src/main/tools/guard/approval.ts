import { dialog } from "electron";
import type { AppConfig } from "@shared/types";
import type {
  ToolApprovalDecision,
  ToolApprovalHandler,
  ToolApprovalRequest
} from "@main/tools/types";

export class ApprovalGuard {
  private readonly rememberedAllow = new Set<string>();

  constructor(private readonly getConfig: () => AppConfig) {}

  async ensureApproved(
    request: ToolApprovalRequest,
    requestApproval?: ToolApprovalHandler
  ): Promise<boolean> {
    if (!this.needsApproval(request.toolName, request.params)) {
      return true;
    }

    if (this.rememberedAllow.has(request.signature)) {
      return true;
    }

    if (requestApproval) {
      const decision = await requestApproval(request);
      if (decision === "allow-always") {
        this.rememberedAllow.add(request.signature);
      }

      return decision === "allow-once" || decision === "allow-always";
    }

    const result = await dialog.showMessageBox({
      type: "question",
      title: "Yobi 操作确认",
      message: "Yobi 想执行以下操作：",
      detail: request.description,
      buttons: ["允许一次", "拒绝", "允许并记住"],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });

    const decision: ToolApprovalDecision =
      result.response === 2 ? "allow-always" : result.response === 0 ? "allow-once" : "deny";

    if (decision === "allow-always") {
      this.rememberedAllow.add(request.signature);
    }

    return decision === "allow-once" || decision === "allow-always";
  }

  needsApproval(toolName: string, params: Record<string, unknown>): boolean {
    const config = this.getConfig();

    if (toolName === "system") {
      if (!config.tools.system.approvalRequired) {
        return false;
      }

      const action = typeof params.action === "string" ? params.action : "";
      return action !== "notify" && action !== "get_windows";
    }

    if (toolName === "file") {
      const action = typeof params.action === "string" ? params.action : "";
      return action === "write" || action === "append";
    }

    return false;
  }
}
