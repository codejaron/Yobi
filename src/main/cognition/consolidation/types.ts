import type {
  ArchiveReport,
  ConsolidationReport,
  GistReport,
  MemoryEdge,
  MemoryNode,
  NovelAssociation,
  ReplayReport
} from "@shared/cognition";

export type { ArchiveReport, ConsolidationReport, GistReport, NovelAssociation, ReplayReport };

export type ConsolidationPhase = "A" | "B" | "C" | "D" | "E";
export type ConsolidationTrigger = "scheduled" | "size_limit" | "manual";

export interface ConsolidationCandidate {
  nodeId: string;
  degreeCentrality: number;
  baseLevelActivation: number;
  reinforcementCount: number;
  lastAccessedAt: number;
  bucket: "consolidate" | "forget" | "normal";
}

export interface ConsolidationState {
  trigger: ConsolidationTrigger;
  started_at: string;
  lastCompletedPhase?: ConsolidationPhase;
  phaseB_candidateIds?: string[];
  phaseB_lastProcessedIndex?: number;
  phaseD_candidateIds?: string[];
  phaseD_lastProcessedIndex?: number;
}

export interface ArchivedNodeRecord {
  node: MemoryNode;
  edges: MemoryEdge[];
  archived_at: string;
}

export interface ColdIndexEntry {
  id: string;
  embedding: number[];
  month: string;
  created_at: number;
  content_preview: string;
}

export interface PendingRecallRecord {
  node: MemoryNode;
  edges: MemoryEdge[];
}
