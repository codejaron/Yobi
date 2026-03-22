import type { CognitionConfig, MemoryNode, NovelAssociation } from "@shared/cognition";
import { spread } from "../activation/spreading-activation";
import { applyHebbianLearning } from "../graph/hebbian-learning";
import { MemoryGraphStore } from "../graph/memory-graph";
import type { ReplayReport } from "./types";

interface SleepReplayInput {
  graph: MemoryGraphStore;
  getCognitionConfig: () => CognitionConfig;
}

export class SleepReplay {
  constructor(private readonly input: SleepReplayInput) {}

  async replayConsolidationCandidates(input: {
    candidateIds: string[];
    startIndex: number;
    checkpointInterval: number;
    onCheckpoint?: (lastProcessedIndex: number) => Promise<void> | void;
    shouldInterrupt?: () => boolean;
  }): Promise<ReplayReport & { novelAssociations: NovelAssociation[] }> {
    const config = this.input.getCognitionConfig();
    const topReplayResults: Array<{ seedId: string; activated: Map<string, number>; peak: number }> = [];
    let replayedCount = 0;
    let strengthenedEdges = 0;
    let lastProcessedIndex = input.startIndex - 1;

    for (let index = input.startIndex; index < input.candidateIds.length; index += 1) {
      if (input.shouldInterrupt?.()) {
        break;
      }

      const candidateId = input.candidateIds[index]!;
      const node = this.input.graph.getNode(candidateId);
      if (!node) {
        lastProcessedIndex = index;
        continue;
      }

      const replayResult = spread(
        this.input.graph,
        [{ nodeId: candidateId, energy: 1 }],
        {
          spreading: config.spreading,
          inhibition: config.inhibition,
          sigmoid: config.sigmoid
        },
        {
          overrideConfig: {
            spreading_factor: config.consolidation.replay_spreading_factor,
            diffusion_max_depth: config.consolidation.replay_diffusion_depth
          }
        }
      );
      const hebbianLog = applyHebbianLearning(this.input.graph, replayResult.activated, {
        ...config.hebbian,
        learning_rate: config.consolidation.replay_hebbian_rate
      });
      const refreshedNode = this.input.graph.getNode(candidateId);
      if (refreshedNode) {
        this.bumpConsolidationMetadata(refreshedNode);
      }

      replayedCount += 1;
      strengthenedEdges += hebbianLog.edges_strengthened;
      lastProcessedIndex = index;

      topReplayResults.push({
        seedId: candidateId,
        activated: replayResult.activated,
        peak: Math.max(...[...replayResult.activated.values(), 0])
      });
      topReplayResults.sort((left, right) => right.peak - left.peak || left.seedId.localeCompare(right.seedId));
      if (topReplayResults.length > 5) {
        topReplayResults.pop();
      }

      if ((index + 1) % input.checkpointInterval === 0) {
        await Promise.resolve(input.onCheckpoint?.(index));
      }
    }

    const novelAssociations = this.detectNovelAssociations(topReplayResults);
    return {
      replayedCount,
      strengthenedEdges,
      novelAssociationsCount: novelAssociations.length,
      lastProcessedIndex,
      novelAssociations
    };
  }

  private detectNovelAssociations(
    results: Array<{ seedId: string; activated: Map<string, number>; peak: number }>
  ): NovelAssociation[] {
    const associations: NovelAssociation[] = [];
    for (let leftIndex = 0; leftIndex < results.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < results.length; rightIndex += 1) {
        const left = results[leftIndex]!;
        const right = results[rightIndex]!;
        const leftNode = this.input.graph.getNode(left.seedId);
        const rightNode = this.input.graph.getNode(right.seedId);
        if (!leftNode || !rightNode) {
          continue;
        }
        if (leftNode.type === rightNode.type && leftNode.content.slice(0, 4) === rightNode.content.slice(0, 4)) {
          continue;
        }

        const sharedActivatedNodes = [...left.activated.keys()]
          .filter((nodeId) => nodeId !== left.seedId && nodeId !== right.seedId && right.activated.has(nodeId))
          .sort();
        if (sharedActivatedNodes.length < 2) {
          continue;
        }
        associations.push({
          seedA_id: left.seedId,
          seedB_id: right.seedId,
          sharedActivatedNodes: sharedActivatedNodes.slice(0, 10),
          activationPeak: Math.max(left.peak, right.peak)
        });
      }
    }
    return associations;
  }

  private bumpConsolidationMetadata(node: MemoryNode): void {
    const currentCount = node.consolidation_count ?? 0;
    this.input.graph.replaceNode({
      ...node,
      consolidation_count: currentCount + 1,
      last_consolidated_at: new Date().toISOString()
    });
  }
}
