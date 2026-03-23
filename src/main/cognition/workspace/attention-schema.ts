import type {
  ActivationResult,
  AttentionWorkspaceState,
  CognitionConfig,
  ThoughtBubble
} from "@shared/cognition";
import type { CompanionPaths } from "@main/storage/paths";
import { readJsonFile, writeJsonFileAtomic } from "@main/storage/fs";

interface AttentionSchemaInput {
  paths: CompanionPaths;
  getCognitionConfig: () => CognitionConfig;
}

function sortActivationEntries(entries: Array<[string, number]>): Array<[string, number]> {
  return entries.sort((left, right) => {
    if (right[1] !== left[1]) {
      return right[1] - left[1];
    }
    return left[0].localeCompare(right[0]);
  });
}

export class AttentionSchema {
  private focusNodeIds: string[] = [];

  constructor(private readonly input: AttentionSchemaInput) {}

  async load(): Promise<AttentionWorkspaceState> {
    const raw = await readJsonFile<unknown>(this.input.paths.cognitionAttentionFocusPath, null);
    const focusNodeIds = Array.isArray((raw as Record<string, unknown> | null)?.focusNodeIds)
      ? ((raw as Record<string, unknown>).focusNodeIds as unknown[]).map((value) => String(value))
      : [];
    this.focusNodeIds = focusNodeIds.slice(0, this.input.getCognitionConfig().attention.max_focus_nodes);
    return this.getWorkspaceState();
  }

  updateFromActivation(activationResult: ActivationResult): AttentionWorkspaceState {
    const maxFocusNodes = this.input.getCognitionConfig().attention.max_focus_nodes;
    this.focusNodeIds = sortActivationEntries([...activationResult.activated.entries()])
      .slice(0, maxFocusNodes)
      .map(([nodeId]) => nodeId);
    return this.getWorkspaceState();
  }

  updateFromBroadcast(bubble: ThoughtBubble): AttentionWorkspaceState {
    const config = this.input.getCognitionConfig();
    const broadcastTopIds = [...bubble.activated_nodes]
      .sort((left, right) => right.activation - left.activation || left.node_id.localeCompare(right.node_id))
      .slice(0, config.workspace.broadcast_focus_top_n)
      .map((item) => item.node_id);
    const nextFocus: string[] = [];
    for (const nodeId of broadcastTopIds) {
      if (!nextFocus.includes(nodeId)) {
        nextFocus.push(nodeId);
      }
    }
    for (const existing of this.focusNodeIds) {
      if (!nextFocus.includes(existing)) {
        nextFocus.push(existing);
      }
    }
    this.focusNodeIds = nextFocus.slice(0, config.attention.max_focus_nodes);
    return this.getWorkspaceState();
  }

  pruneInvalidFocusNodes(isValidNode: (nodeId: string) => boolean): number {
    const nextFocusNodeIds = this.focusNodeIds.filter((nodeId) => isValidNode(nodeId));
    const removed = this.focusNodeIds.length - nextFocusNodeIds.length;
    this.focusNodeIds = nextFocusNodeIds;
    return removed;
  }

  reset(): void {
    this.focusNodeIds = [];
  }

  injectFocusSeeds(
    currentSeeds: Array<{ nodeId: string; energy: number }>,
    options?: { isValidNode?: (nodeId: string) => boolean }
  ): Array<{ nodeId: string; energy: number }> {
    if (options?.isValidNode) {
      this.pruneInvalidFocusNodes(options.isValidNode);
    }
    const energy = this.input.getCognitionConfig().attention.focus_seed_energy;
    const byId = new Map<string, { nodeId: string; energy: number }>();
    for (const seed of currentSeeds) {
      byId.set(seed.nodeId, seed);
    }
    for (const nodeId of this.focusNodeIds) {
      const current = byId.get(nodeId);
      if (!current || current.energy < energy) {
        byId.set(nodeId, {
          nodeId,
          energy
        });
      }
    }
    return [...byId.values()].sort((left, right) => {
      if (right.energy !== left.energy) {
        return right.energy - left.energy;
      }
      return left.nodeId.localeCompare(right.nodeId);
    });
  }

  getWorkspaceState(): AttentionWorkspaceState {
    const config = this.input.getCognitionConfig().attention;
    return {
      focus_node_ids: [...this.focusNodeIds],
      max_focus_nodes: config.max_focus_nodes,
      focus_seed_energy: config.focus_seed_energy
    };
  }

  async persist(): Promise<void> {
    await writeJsonFileAtomic(this.input.paths.cognitionAttentionFocusPath, {
      focusNodeIds: this.focusNodeIds,
      last_updated: new Date().toISOString()
    });
  }
}
