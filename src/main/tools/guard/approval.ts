import { dialog } from "electron";
import type { CommandApprovalDecision } from "@shared/types";
import { ConversationAbortError } from "@main/core/conversation-abort";
import type {
  ToolApprovalHandler,
  ToolApprovalRequest
} from "@main/tools/types";

export class ApprovalGuard {
  private readonly rememberedAllow = new Set<string>();

  async ensureApproved(
    request: ToolApprovalRequest,
    requestApproval?: ToolApprovalHandler
  ): Promise<boolean> {
    if (this.rememberedAllow.has(request.signature)) {
      return true;
    }

    if (requestApproval) {
      const outcome = await requestApproval(request);
      if (outcome.kind === "aborted") {
        throw new ConversationAbortError();
      }

      const decision = outcome.decision;
      this.applyDecision(request.signature, decision);
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

    const decision: CommandApprovalDecision =
      result.response === 2 ? "allow-always" : result.response === 0 ? "allow-once" : "deny";

    this.applyDecision(request.signature, decision);
    return decision === "allow-once" || decision === "allow-always";
  }

  private applyDecision(signature: string, decision: CommandApprovalDecision): void {
    if (decision === "allow-always") {
      this.rememberedAllow.add(signature);
    }
  }
}
