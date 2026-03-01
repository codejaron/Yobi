import { randomUUID } from "node:crypto";
import type { CommandApprovalDecision, ConsoleRunEventV2 } from "@shared/types";
import type { ToolApprovalHandler, ToolApprovalRequest } from "@main/tools/types";

interface PendingApproval {
  requestId: string;
  resolve: (decision: CommandApprovalDecision) => void;
}

export class ConsoleChannel {
  private listeners = new Set<(event: ConsoleRunEventV2) => void>();
  private pendingApprovals = new Map<string, PendingApproval>();

  onEvent(listener: (event: ConsoleRunEventV2) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: ConsoleRunEventV2): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  emitExternalAssistantMessage(input: { text: string; source: "claw" }): void {
    const text = input.text.trim();
    if (!text) {
      return;
    }

    this.emit({
      requestId: `external-${randomUUID()}`,
      type: "external-assistant-message",
      messageId: randomUUID(),
      text,
      source: input.source,
      timestamp: new Date().toISOString()
    });
  }

  makeApprovalHandler(requestId: string): ToolApprovalHandler {
    return async (request: ToolApprovalRequest) => {
      if (this.listeners.size === 0) {
        return "deny";
      }

      const approvalId = randomUUID();
      this.emit({
        requestId,
        type: "approval-request",
        approvalId,
        toolName: request.toolName,
        description: request.description,
        timestamp: new Date().toISOString()
      });

      return new Promise<CommandApprovalDecision>((resolve) => {
        this.pendingApprovals.set(approvalId, {
          requestId,
          resolve
        });
      });
    };
  }

  resolveApproval(input: {
    approvalId: string;
    decision: CommandApprovalDecision;
  }): { accepted: boolean } {
    const pending = this.pendingApprovals.get(input.approvalId);
    if (!pending) {
      return {
        accepted: false
      };
    }

    this.pendingApprovals.delete(input.approvalId);
    pending.resolve(input.decision);

    this.emit({
      requestId: pending.requestId,
      type: "approval-decision",
      approvalId: input.approvalId,
      decision: input.decision,
      timestamp: new Date().toISOString()
    });

    return {
      accepted: true
    };
  }

  flushByRequest(requestId: string): void {
    for (const [approvalId, pending] of this.pendingApprovals.entries()) {
      if (pending.requestId !== requestId) {
        continue;
      }

      this.pendingApprovals.delete(approvalId);
      pending.resolve("deny");
    }
  }
}
