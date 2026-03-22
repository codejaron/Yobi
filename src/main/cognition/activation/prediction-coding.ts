import type {
  CognitionConfig,
  PredictionWorkspaceState
} from "@shared/cognition";
import type { CompanionPaths } from "@main/storage/paths";
import { readJsonFile, writeJsonFileAtomic } from "@main/storage/fs";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm <= 0 || rightNorm <= 0) {
    return 0;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function encodeFingerprint(
  activationMap: Map<string, number>,
  allNodeIds: string[]
): Float32Array {
  const sortedNodeIds = [...allNodeIds].sort((left, right) => left.localeCompare(right));
  const vector = new Float32Array(sortedNodeIds.length);
  for (let index = 0; index < sortedNodeIds.length; index += 1) {
    const nodeId = sortedNodeIds[index]!;
    vector[index] = activationMap.get(nodeId) ?? 0;
  }
  return vector;
}

export interface PredictionCodingResult {
  activated: Map<string, number>;
  status: "warming_up" | "active";
  progress: string;
  similarity: number | null;
  surprisingNodes: Array<{ node_id: string; activation: number }>;
  familiarNodes: Array<{ node_id: string; activation: number }>;
}

interface PredictionEngineInput {
  paths: CompanionPaths;
  getCognitionConfig: () => CognitionConfig;
}

export class PredictionEngine {
  private history: Float32Array[] = [];
  private workspaceState: PredictionWorkspaceState;

  constructor(private readonly input: PredictionEngineInput) {
    const historyWindow = this.input.getCognitionConfig().prediction.history_window;
    this.workspaceState = {
      warming_up: true,
      progress: `0/${historyWindow}`,
      history_window: historyWindow,
      last_similarity: null,
      surprising_node_ids: [],
      familiar_node_ids: []
    };
  }

  async load(): Promise<PredictionWorkspaceState> {
    const historyWindow = this.input.getCognitionConfig().prediction.history_window;
    const raw = await readJsonFile<unknown>(this.input.paths.cognitionPredictionVectorPath, null);
    const rawRecord = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : null;
    const historyRows: unknown[] = Array.isArray(rawRecord?.history) ? rawRecord.history : [];
    this.history = historyRows
      .filter((row): row is number[] => Array.isArray(row) && row.every((value) => typeof value === "number"))
      .slice(-historyWindow)
      .map((row) => Float32Array.from(row));
    this.workspaceState = {
      warming_up: this.history.length < historyWindow,
      progress: `${Math.min(this.history.length, historyWindow)}/${historyWindow}`,
      history_window: historyWindow,
      last_similarity: typeof rawRecord?.last_similarity === "number"
        ? Number(rawRecord.last_similarity)
        : null,
      surprising_node_ids: Array.isArray(rawRecord?.surprising_node_ids)
        ? (rawRecord.surprising_node_ids as unknown[]).map((value) => String(value))
        : [],
      familiar_node_ids: Array.isArray(rawRecord?.familiar_node_ids)
        ? (rawRecord.familiar_node_ids as unknown[]).map((value) => String(value))
        : []
    };
    return this.getWorkspaceState();
  }

  getWorkspaceState(): PredictionWorkspaceState {
    return {
      ...this.workspaceState,
      surprising_node_ids: [...(this.workspaceState.surprising_node_ids ?? [])],
      familiar_node_ids: [...(this.workspaceState.familiar_node_ids ?? [])]
    };
  }

  isWarmingUp(): boolean {
    return this.history.length < this.input.getCognitionConfig().prediction.history_window;
  }

  getWarmupProgress(): string {
    const historyWindow = this.input.getCognitionConfig().prediction.history_window;
    return `${Math.min(this.history.length, historyWindow)}/${historyWindow}`;
  }

  applyPredictionCoding(
    activationMap: Map<string, number>,
    allNodeIds: string[]
  ): PredictionCodingResult {
    const config = this.input.getCognitionConfig().prediction;
    const currentVector = encodeFingerprint(activationMap, allNodeIds);
    if (this.history.length < config.history_window) {
      const progress = `${Math.min(config.history_window, this.history.length + 1)}/${config.history_window}`;
      this.workspaceState = {
        warming_up: true,
        progress,
        history_window: config.history_window,
        last_similarity: null,
        surprising_node_ids: [],
        familiar_node_ids: []
      };
      return {
        activated: new Map(activationMap),
        status: "warming_up",
        progress,
        similarity: null,
        surprisingNodes: [],
        familiarNodes: []
      };
    }

    const expectedVector = this.computeExpectedVector(currentVector.length);
    const similarity = cosineSimilarity(currentVector, expectedVector);
    const next = new Map(activationMap);
    const surprisingNodes: Array<{ node_id: string; activation: number }> = [];
    const familiarNodes: Array<{ node_id: string; activation: number }> = [];
    const sortedNodeIds = [...allNodeIds].sort((left, right) => left.localeCompare(right));

    for (let index = 0; index < sortedNodeIds.length; index += 1) {
      const nodeId = sortedNodeIds[index]!;
      const current = currentVector[index] ?? 0;
      const expected = expectedVector[index] ?? 0;
      if (current <= expected || current <= 0) {
        continue;
      }

      if (similarity < config.similarity_threshold) {
        const updated = current * (1 + config.surprise_bonus);
        next.set(nodeId, updated);
        surprisingNodes.push({ node_id: nodeId, activation: updated });
      } else {
        const updated = current * (1 - config.familiarity_penalty);
        next.set(nodeId, Math.max(0, updated));
        familiarNodes.push({ node_id: nodeId, activation: Math.max(0, updated) });
      }
    }

    this.workspaceState = {
      warming_up: false,
      progress: `${config.history_window}/${config.history_window}`,
      history_window: config.history_window,
      last_similarity: similarity,
      surprising_node_ids: surprisingNodes.map((node) => node.node_id),
      familiar_node_ids: familiarNodes.map((node) => node.node_id)
    };
    return {
      activated: next,
      status: "active",
      progress: this.workspaceState.progress,
      similarity,
      surprisingNodes: surprisingNodes
        .sort((left, right) => right.activation - left.activation || left.node_id.localeCompare(right.node_id)),
      familiarNodes: familiarNodes
        .sort((left, right) => right.activation - left.activation || left.node_id.localeCompare(right.node_id))
    };
  }

  recordActivationFingerprint(
    activationMap: Map<string, number>,
    allNodeIds: string[]
  ): void {
    const config = this.input.getCognitionConfig().prediction;
    this.history.push(encodeFingerprint(activationMap, allNodeIds));
    if (this.history.length > config.history_window) {
      this.history = this.history.slice(-config.history_window);
    }

    if (this.workspaceState.warming_up) {
      this.workspaceState = {
        ...this.workspaceState,
        warming_up: this.history.length < config.history_window,
        progress: `${Math.min(this.history.length, config.history_window)}/${config.history_window}`,
        history_window: config.history_window
      };
    }
  }

  async persist(): Promise<void> {
    await writeJsonFileAtomic(this.input.paths.cognitionPredictionVectorPath, {
      history: this.history.map((row) => Array.from(row)),
      last_similarity: this.workspaceState.last_similarity ?? null,
      surprising_node_ids: this.workspaceState.surprising_node_ids ?? [],
      familiar_node_ids: this.workspaceState.familiar_node_ids ?? [],
      warming_up: this.workspaceState.warming_up,
      last_updated: new Date().toISOString()
    });
  }

  private computeExpectedVector(length: number): Float32Array {
    if (this.history.length === 0) {
      return new Float32Array(length);
    }

    const expected = new Float32Array(length);
    for (const row of this.history) {
      for (let index = 0; index < length; index += 1) {
        expected[index] = (expected[index] ?? 0) + (row[index] ?? 0);
      }
    }
    for (let index = 0; index < length; index += 1) {
      expected[index] = clamp(expected[index] / this.history.length, 0, Number.MAX_SAFE_INTEGER);
    }
    return expected;
  }
}
