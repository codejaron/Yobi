import { appendJsonlLine, readJsonFile, readJsonlFile, writeJsonFileAtomic } from "@main/storage/fs";
import type { CompanionPaths } from "@main/storage/paths";
import type { AppLogger } from "@main/services/logger";
import type { CognitionConfig, ConsolidationReport } from "@shared/cognition";
import { MemoryGraphStore } from "../graph/memory-graph";
import { ColdArchive } from "./cold-archive";
import { GistExtractor } from "./gist-extraction";
import { SleepReplay } from "./sleep-replay";
import { dedupePersonEntities } from "./entity-dedup";
import type {
  ConsolidationCandidate,
  ConsolidationPhase,
  ConsolidationState,
  ConsolidationTrigger
} from "./types";

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)));
  return sorted[index] ?? Number.NEGATIVE_INFINITY;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function startOfUtcDay(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0);
}

interface ConsolidationEngineInput {
  paths: CompanionPaths;
  graph: MemoryGraphStore;
  sleepReplay: SleepReplay;
  gistExtractor: GistExtractor;
  coldArchive: ColdArchive;
  logger: Pick<AppLogger, "warn">;
  getCognitionConfig: () => CognitionConfig;
  getUserActivityState: () => { online: boolean; last_active: number | null };
}

export class ConsolidationEngine {
  private running = false;
  private interrupted = false;
  private lastReport: ConsolidationReport | null = null;

  constructor(private readonly input: ConsolidationEngineInput) {}

  async load(): Promise<void> {
    const history = await this.getHistory(1);
    this.lastReport = history[0] ?? null;
  }

  isRunning(): boolean {
    return this.running;
  }

  interrupt(): void {
    this.interrupted = true;
  }

  shouldTrigger(): { should: boolean; trigger?: ConsolidationTrigger; reason?: string } {
    const config = this.input.getCognitionConfig().consolidation;
    if (!config.enabled || this.running) {
      return { should: false };
    }

    const stats = this.input.graph.getStatistics();
    if (stats.nodeCount > config.hot_node_limit) {
      return {
        should: true,
        trigger: "size_limit",
        reason: `hot-zone-limit:${stats.nodeCount}`
      };
    }

    const now = new Date();
    const hour = now.getHours();
    if (hour < config.schedule_hour_start || hour >= config.schedule_hour_end) {
      return { should: false };
    }

    const activity = this.input.getUserActivityState();
    const lastActive = activity.last_active ?? 0;
    const silentEnough = lastActive <= 0 || (Date.now() - lastActive) >= config.silence_threshold_hours * 3_600_000;
    if (!silentEnough) {
      return { should: false };
    }

    return {
      should: true,
      trigger: "scheduled",
      reason: "scheduled-window"
    };
  }

  async runConsolidation(trigger: ConsolidationTrigger): Promise<ConsolidationReport> {
    if (this.running) {
      throw new Error("consolidation already running");
    }

    this.running = true;
    this.interrupted = false;
    const startedAtMs = Date.now();
    const startedAtIso = new Date(startedAtMs).toISOString();
    const config = this.input.getCognitionConfig().consolidation;
    const deadlineMs = startedAtMs + config.max_consolidation_duration_minutes * 60_000;
    const state = await this.loadState();
    const before = this.input.graph.getStatistics();
    const snapshot = this.scanCandidates(startedAtMs);
    await appendJsonlLine(this.input.paths.cognitionConsolidationLogPath, {
      type: "snapshot",
      trigger,
      started_at: startedAtIso,
      candidate_counts: {
        consolidate: snapshot.consolidateIds.length,
        forget: snapshot.forgetIds.length,
        normal: snapshot.normalCount
      }
    });

    let lastCompletedPhase: ConsolidationPhase = "A";
    let interrupted = false;
    let replayReport = {
      replayedCount: 0,
      strengthenedEdges: 0,
      novelAssociationsCount: 0,
      lastProcessedIndex: -1
    };
    let novelAssociations = [] as ConsolidationReport["novel_associations"];
    let gistReport = {
      clusterCount: 0,
      abstractNodesCreated: 0,
      skippedClusters: 0,
      newRelatedEdges: 0
    };
    let mergedEntities = [] as ConsolidationReport["merged_entities"];
    let archiveReport = {
      migratedCount: 0,
      excludedByAbstraction: 0,
      orphansMigrated: 0,
      lastProcessedIndex: -1
    };

    try {
      const phaseBCandidateIds = state?.phaseB_candidateIds?.length
        ? state.phaseB_candidateIds
        : snapshot.consolidateIds;
      const phaseBStartIndex =
        state?.phaseB_candidateIds?.length && typeof state.phaseB_lastProcessedIndex === "number"
          ? state.phaseB_lastProcessedIndex + 1
          : 0;
      await this.saveState({
        trigger,
        started_at: state?.started_at ?? startedAtIso,
        lastCompletedPhase: "A",
        phaseB_candidateIds: phaseBCandidateIds,
        phaseB_lastProcessedIndex: phaseBStartIndex - 1
      });
      const replayResult = await this.input.sleepReplay.replayConsolidationCandidates({
        candidateIds: phaseBCandidateIds,
        startIndex: phaseBStartIndex,
        checkpointInterval: config.checkpoint_interval_nodes,
        shouldInterrupt: () => this.shouldStop(deadlineMs),
        onCheckpoint: async (lastProcessedIndex) => {
          await this.saveState({
            trigger,
            started_at: state?.started_at ?? startedAtIso,
            lastCompletedPhase: "A",
            phaseB_candidateIds: phaseBCandidateIds,
            phaseB_lastProcessedIndex: lastProcessedIndex
          });
        }
      });
      replayReport = replayResult;
      novelAssociations = replayResult.novelAssociations;
      lastCompletedPhase = "B";
      interrupted = this.shouldStop(deadlineMs);
      if (interrupted) {
        await this.saveState({
          trigger,
          started_at: state?.started_at ?? startedAtIso,
          lastCompletedPhase: "A",
          phaseB_candidateIds: phaseBCandidateIds,
          phaseB_lastProcessedIndex: replayResult.lastProcessedIndex
        });
      } else {
        await this.saveState({
          trigger,
          started_at: state?.started_at ?? startedAtIso,
          lastCompletedPhase: "B"
        });
      }
      if (interrupted) {
        return await this.finishReport({
          trigger,
          startedAtMs,
          startedAtIso,
          before,
          replayReport,
          gistReport,
          archiveReport,
          mergedEntities,
          novelAssociations,
          interrupted,
          lastCompletedPhase
        });
      }

      mergedEntities = dedupePersonEntities({
        graph: this.input.graph,
        cognitionConfig: this.input.getCognitionConfig()
      }).mergedEntities;
      const windowStartMs = this.lastReport ? Date.parse(this.lastReport.completed_at) : startOfUtcDay(startedAtMs);
      gistReport = await this.input.gistExtractor.extractAbstractions({
        start: windowStartMs,
        end: startedAtMs
      });
      lastCompletedPhase = "C";
      interrupted = this.shouldStop(deadlineMs);
      if (interrupted) {
        await this.saveState({
          trigger,
          started_at: state?.started_at ?? startedAtIso,
          lastCompletedPhase: "C"
        });
        return await this.finishReport({
          trigger,
          startedAtMs,
          startedAtIso,
          before,
          replayReport,
          gistReport,
          archiveReport,
          mergedEntities,
          novelAssociations,
          interrupted,
          lastCompletedPhase
        });
      }

      const phaseDCandidateIds = state?.phaseD_candidateIds?.length
        ? state.phaseD_candidateIds
        : this.filterForgetCandidates(snapshot.forgetIds);
      const excludedByAbstraction = snapshot.forgetIds.length - phaseDCandidateIds.length;
      const phaseDStartIndex =
        state?.phaseD_candidateIds?.length && typeof state.phaseD_lastProcessedIndex === "number"
          ? state.phaseD_lastProcessedIndex + 1
          : 0;
      await this.saveState({
        trigger,
        started_at: state?.started_at ?? startedAtIso,
        lastCompletedPhase: "C",
        phaseD_candidateIds: phaseDCandidateIds,
        phaseD_lastProcessedIndex: phaseDStartIndex - 1
      });
      const migration = await this.input.coldArchive.migrateNodes({
        candidateIds: phaseDCandidateIds,
        graph: this.input.graph,
        startIndex: phaseDStartIndex,
        checkpointInterval: config.checkpoint_interval_nodes,
        shouldInterrupt: () => this.shouldStop(deadlineMs),
        onCheckpoint: async (lastProcessedIndex) => {
          await this.saveState({
            trigger,
            started_at: state?.started_at ?? startedAtIso,
            lastCompletedPhase: "C",
            phaseD_candidateIds: phaseDCandidateIds,
            phaseD_lastProcessedIndex: lastProcessedIndex
          });
        }
      });
      archiveReport = {
        ...migration,
        excludedByAbstraction,
        orphansMigrated: 0
      };
      const orphanIds = this.input.graph.getOrphanNodes().map((node) => node.id);
      if (orphanIds.length > 0 && !this.shouldStop(deadlineMs)) {
        const orphanMigration = await this.input.coldArchive.migrateNodes({
          candidateIds: orphanIds,
          graph: this.input.graph,
          startIndex: 0,
          checkpointInterval: config.checkpoint_interval_nodes,
          shouldInterrupt: () => this.shouldStop(deadlineMs)
        });
        archiveReport.orphansMigrated = orphanMigration.migratedCount;
      }
      lastCompletedPhase = "D";
      interrupted = this.shouldStop(deadlineMs);
      if (interrupted) {
        await this.saveState({
          trigger,
          started_at: state?.started_at ?? startedAtIso,
          lastCompletedPhase: "C",
          phaseD_candidateIds: phaseDCandidateIds,
          phaseD_lastProcessedIndex: archiveReport.lastProcessedIndex
        });
      } else {
        await this.saveState({
          trigger,
          started_at: state?.started_at ?? startedAtIso,
          lastCompletedPhase: "D"
        });
      }

      const report = await this.finishReport({
        trigger,
        startedAtMs,
        startedAtIso,
        before,
        replayReport,
        gistReport,
        archiveReport,
        mergedEntities,
        novelAssociations,
        interrupted,
        lastCompletedPhase: interrupted ? "D" : "E"
      });
      if (!interrupted) {
        await this.clearState();
      }
      return report;
    } finally {
      this.running = false;
      this.interrupted = false;
    }
  }

  async getLastReport(): Promise<ConsolidationReport | null> {
    if (this.lastReport) {
      return this.lastReport;
    }
    const history = await this.getHistory(1);
    this.lastReport = history[0] ?? null;
    return this.lastReport;
  }

  async getHistory(limit = 20): Promise<ConsolidationReport[]> {
    const rows = await readJsonlFile<unknown>(this.input.paths.cognitionConsolidationLogPath);
    return rows
      .filter((row): row is ConsolidationReport => {
        if (!row || typeof row !== "object") {
          return false;
        }
        const record = row as Record<string, unknown>;
        return typeof record.completed_at === "string" && typeof record.trigger === "string" && record.after !== undefined;
      })
      .map((row) => ({
        ...row,
        merged_entities: Array.isArray(row.merged_entities) ? row.merged_entities : []
      }))
      .slice(-limit)
      .reverse();
  }

  private scanCandidates(nowMs: number): {
    consolidateIds: string[];
    forgetIds: string[];
    normalCount: number;
  } {
    const nodes = this.input.graph.getAllNodes();
    const degreeValues: number[] = [];
    const baseValues: number[] = [];
    const scored: ConsolidationCandidate[] = [];

    for (const node of nodes) {
      const degreeCentrality = this.input.graph.getDegreeCentrality(node.id);
      const baseLevelActivation = this.input.graph.computeBaseLevelActivation(
        node.id,
        nowMs,
        this.input.getCognitionConfig().actr.decay_d
      );
      const reinforcementCount = typeof node.metadata.reinforcement_count === "number"
        ? Number(node.metadata.reinforcement_count)
        : 0;
      const lastAccessedAt = node.last_activated_at || node.created_at;
      degreeValues.push(degreeCentrality);
      if (Number.isFinite(baseLevelActivation)) {
        baseValues.push(baseLevelActivation);
      }
      scored.push({
        nodeId: node.id,
        degreeCentrality,
        baseLevelActivation,
        reinforcementCount,
        lastAccessedAt,
        bucket: "normal"
      });
    }

    const degreeMedian = median(degreeValues);
    const baseTop20 = percentile(baseValues, 0.8);
    const baseBottom20 = percentile(baseValues, 0.2);
    const forgetBeforeMs = nowMs - this.input.getCognitionConfig().consolidation.forget_threshold_days * 24 * 3_600_000;

    const consolidateIds: string[] = [];
    const forgetIds: string[] = [];
    let normalCount = 0;
    for (const candidate of scored) {
      const consolidate =
        (candidate.degreeCentrality >= degreeMedian && candidate.reinforcementCount >= 1) ||
        candidate.baseLevelActivation >= baseTop20;
      const forget =
        candidate.baseLevelActivation <= baseBottom20 &&
        candidate.lastAccessedAt < forgetBeforeMs;
      if (consolidate) {
        consolidateIds.push(candidate.nodeId);
      } else if (forget) {
        forgetIds.push(candidate.nodeId);
      } else {
        normalCount += 1;
      }
    }

    return {
      consolidateIds,
      forgetIds,
      normalCount
    };
  }

  private filterForgetCandidates(candidateIds: string[]): string[] {
    const filtered: string[] = [];
    for (const nodeId of candidateIds) {
      const incoming = this.input.graph.getIncomingEdges(nodeId);
      const referencedByAbstract = incoming.some((edge) => edge.relation_type === "abstracts");
      if (!referencedByAbstract) {
        filtered.push(nodeId);
      }
    }
    return filtered;
  }

  private async finishReport(input: {
    trigger: ConsolidationTrigger;
    startedAtMs: number;
    startedAtIso: string;
    before: ReturnType<MemoryGraphStore["getStatistics"]>;
    replayReport: ConsolidationReport["replay_report"];
    gistReport: ConsolidationReport["gist_report"];
    archiveReport: ConsolidationReport["archive_report"];
    mergedEntities: ConsolidationReport["merged_entities"];
    novelAssociations: ConsolidationReport["novel_associations"];
    interrupted: boolean;
    lastCompletedPhase: ConsolidationPhase;
  }): Promise<ConsolidationReport> {
    const after = this.input.graph.getStatistics();
    const healthCheck = {
      hot_node_limit_ok: after.nodeCount < this.input.getCognitionConfig().consolidation.hot_node_limit,
      no_orphans: this.input.graph.getOrphanNodes().length === 0,
      no_self_loops: this.input.graph.getAllEdges().every((edge) => edge.source !== edge.target),
      weight_mean_ok: after.meanWeight < 0.6,
      weight_max_ok: after.maxWeight <= 1,
      abstract_growth_ok: input.gistReport.abstractNodesCreated <= Math.max(1, Math.floor(input.gistReport.clusterCount * 0.5) || 0)
    };

    const report: ConsolidationReport = {
      trigger: input.trigger,
      started_at: input.startedAtIso,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - input.startedAtMs,
      replay_report: input.replayReport,
      gist_report: input.gistReport,
      archive_report: input.archiveReport,
      novel_associations: input.novelAssociations,
      health_check: healthCheck,
      before: input.before,
      after,
      merged_entities: input.mergedEntities,
      interrupted: input.interrupted,
      last_completed_phase: input.lastCompletedPhase
    };
    this.lastReport = report;
    await appendJsonlLine(this.input.paths.cognitionConsolidationLogPath, report);
    return report;
  }

  private shouldStop(deadlineMs: number): boolean {
    return this.interrupted || Date.now() >= deadlineMs;
  }

  private async loadState(): Promise<ConsolidationState | null> {
    return readJsonFile<ConsolidationState | null>(this.input.paths.cognitionConsolidationStatePath, null);
  }

  private async saveState(state: ConsolidationState): Promise<void> {
    await writeJsonFileAtomic(this.input.paths.cognitionConsolidationStatePath, state);
  }

  private async clearState(): Promise<void> {
    await writeJsonFileAtomic(this.input.paths.cognitionConsolidationStatePath, null);
  }
}
