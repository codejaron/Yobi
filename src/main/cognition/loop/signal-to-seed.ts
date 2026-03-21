import { MemoryGraphStore } from "../graph/memory-graph";

const MANUAL_SEED_SIMILARITY_THRESHOLD = 0.55;

interface TimeSignalPayload {
  hour: number;
  weekday: string;
  date: string;
}

interface ManualSignalPayload {
  text: string;
}

export type CognitionSignal =
  | { type: "time_signal"; payload: TimeSignalPayload }
  | { type: "manual_signal"; payload: ManualSignalPayload };

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  if (left.length !== right.length) {
    return 0;
  }

  const length = left.length;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
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

function isHourMatch(content: string, hour: number): boolean {
  if (content.includes("中午")) {
    return hour >= 11 && hour <= 13;
  }
  if (content.includes("早上") || content.includes("上午")) {
    return hour >= 6 && hour <= 11;
  }
  if (content.includes("下午")) {
    return hour >= 13 && hour <= 18;
  }
  if (content.includes("晚上")) {
    return hour >= 18 && hour <= 23;
  }
  return false;
}

function weekdayAliases(weekday: string): string[] {
  const normalized = weekday.toLowerCase();
  const aliases: Record<string, string[]> = {
    sunday: ["sunday", "星期日", "星期天", "周日"],
    monday: ["monday", "星期一", "周一"],
    tuesday: ["tuesday", "星期二", "周二"],
    wednesday: ["wednesday", "星期三", "周三"],
    thursday: ["thursday", "星期四", "周四"],
    friday: ["friday", "星期五", "周五"],
    saturday: ["saturday", "星期六", "周六"]
  };
  return aliases[normalized] ?? [normalized];
}

export async function signalToSeeds(
  signal: CognitionSignal,
  graph: MemoryGraphStore,
  embedText: (text: string) => Promise<number[] | null>
): Promise<Array<{ nodeId: string; energy: number }>> {
  const nodes = graph.getAllNodes();
  if (nodes.length === 0) {
    return [];
  }

  if (signal.type === "time_signal") {
    const weekdayMatches = weekdayAliases(signal.payload.weekday);
    return nodes
      .filter((node) => node.type === "time_marker")
      .filter((node) => {
        const content = node.content.toLowerCase();
        return (
          isHourMatch(node.content, signal.payload.hour) ||
          weekdayMatches.some((match) => content.includes(match.toLowerCase()))
        );
      })
      .map((node) => ({
        nodeId: node.id,
        energy: 1
      }));
  }

  const text = signal.payload.text.trim();
  if (!text) {
    return [];
  }

  const queryEmbedding = await embedText(text);
  if (!queryEmbedding || queryEmbedding.length === 0) {
    return [];
  }

  return nodes
    .map((node) => ({
      nodeId: node.id,
      energy: cosineSimilarity(queryEmbedding, node.embedding)
    }))
    .filter((item) => item.energy >= MANUAL_SEED_SIMILARITY_THRESHOLD)
    .sort((left, right) => right.energy - left.energy)
    .slice(0, 3);
}
