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

interface WeightedFingerprint {
  fingerprint: Float32Array;
  weight: number;
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
  private history: WeightedFingerprint[] = [];
  private workspaceState: PredictionWorkspaceState;
  lastRecordedTickId: number | null = null;

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
      .map((row) => this.parseWeightedFingerprint(row))
      .filter((row): row is WeightedFingerprint => row !== null)
      .slice(-historyWindow);
    this.lastRecordedTickId = typeof rawRecord?.last_recorded_tick_id === "number"
      ? Number(rawRecord.last_recorded_tick_id)
      : null;
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
    allNodeIds: string[],
    tickId: number,
    weight = 1
  ): void {
    const config = this.input.getCognitionConfig().prediction;
    if (this.lastRecordedTickId === tickId) {
      return;
    }
    this.history.push({
      fingerprint: encodeFingerprint(activationMap, allNodeIds),
      weight
    });
    if (this.history.length > config.history_window) {
      this.history = this.history.slice(-config.history_window);
    }
    this.lastRecordedTickId = tickId;

    if (this.workspaceState.warming_up) {
      this.workspaceState = {
        ...this.workspaceState,
        warming_up: this.history.length < config.history_window,
        progress: `${Math.min(this.history.length, config.history_window)}/${config.history_window}`,
        history_window: config.history_window
      };
    }
  }

  integrateSuccessfulBroadcast(
    activationMap: Map<string, number>,
    allNodeIds: string[],
    broadcastWeight: number,
    tickId: number
  ): void {
    this.recordActivationFingerprint(activationMap, allNodeIds, tickId, broadcastWeight);
  }

  async persist(): Promise<void> {
    await writeJsonFileAtomic(this.input.paths.cognitionPredictionVectorPath, {
      history: this.history.map((row) => ({
        fingerprint: Array.from(row.fingerprint),
        weight: row.weight
      })),
      last_recorded_tick_id: this.lastRecordedTickId,
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
    let totalWeight = 0;
    for (const row of this.history) {
      const weight = row.weight > 0 ? row.weight : 0;
      totalWeight += weight;
      for (let index = 0; index < length; index += 1) {
        expected[index] = (expected[index] ?? 0) + (row.fingerprint[index] ?? 0) * weight;
      }
    }
    if (totalWeight <= 0) {
      return expected;
    }
    for (let index = 0; index < length; index += 1) {
      expected[index] = clamp(expected[index] / totalWeight, 0, Number.MAX_SAFE_INTEGER);
    }
    return expected;
  }

  private parseWeightedFingerprint(input: unknown): WeightedFingerprint | null {
    if (Array.isArray(input) && input.every((value) => typeof value === "number")) {
      return {
        fingerprint: Float32Array.from(input),
        weight: 1
      };
    }
    if (!input || typeof input !== "object") {
      return null;
    }
    const record = input as Record<string, unknown>;
    if (!Array.isArray(record.fingerprint) || !record.fingerprint.every((value) => typeof value === "number")) {
      return null;
    }
    const weight = typeof record.weight === "number" ? record.weight : 1;
    return {
      fingerprint: Float32Array.from(record.fingerprint as number[]),
      weight
    };
  }
}
