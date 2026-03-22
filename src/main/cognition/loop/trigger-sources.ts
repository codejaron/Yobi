import type { TriggerConfig } from "@shared/cognition";
import { MemoryGraphStore } from "../graph/memory-graph";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export interface TriggerSignal {
  type: "time_signal" | "dialogue_residue" | "silence" | "random_walk" | "low_activation_rescue";
  payload: Record<string, unknown>;
  source_description: string;
}

export function selectTriggers(
  graph: MemoryGraphStore,
  recentDialogue: string[] | null,
  lastDialogueTime: number | null,
  userState: { online: boolean; last_active: number | null },
  config: TriggerConfig
): TriggerSignal[] {
  return selectTriggersWithOptions(graph, recentDialogue, lastDialogueTime, userState, config, {});
}

export function selectTriggersWithOptions(
  graph: MemoryGraphStore,
  recentDialogue: string[] | null,
  lastDialogueTime: number | null,
  userState: { online: boolean; last_active: number | null },
  config: TriggerConfig,
  options: {
    nowMs?: number;
    decayD?: number;
  }
): TriggerSignal[] {
  const result: TriggerSignal[] = [];
  const nowMs = options.nowMs ?? Date.now();

  if (
    lastDialogueTime &&
    nowMs - lastDialogueTime < config.dialogue_residue_window_minutes * 60 * 1000 &&
    recentDialogue &&
    recentDialogue.length > 0
  ) {
    const text = recentDialogue[recentDialogue.length - 1] ?? "";
    result.push({
      type: "dialogue_residue",
      payload: { text },
      source_description: `对话残留：${text.slice(0, 30)}`
    });
  } else if (
    userState.online &&
    userState.last_active &&
    nowMs - userState.last_active > config.silence_threshold_minutes * 60 * 1000
  ) {
    const silenceMinutes = Math.round((nowMs - userState.last_active) / 60_000);
    result.push({
      type: "silence",
      payload: {
        duration_minutes: silenceMinutes
      },
      source_description: `用户静默 ${silenceMinutes} 分钟`
    });
  } else {
    const now = new Date(nowMs);
    result.push({
      type: "time_signal",
      payload: {
        hour: now.getHours(),
        minute: now.getMinutes(),
        weekday: DAY_NAMES[now.getDay()],
        date: now.toISOString().slice(0, 10)
      },
      source_description: `时间信号：${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")} ${DAY_NAMES[now.getDay()]}`
    });
  }

  if (Math.random() < config.random_walk_probability) {
    const randomNode = graph.getRandomNode();
    if (randomNode) {
      result.push({
        type: "random_walk",
        payload: {
          node_id: randomNode.id,
          node_content: randomNode.content
        },
        source_description: `随机游走：${randomNode.content.slice(0, 30)}`
      });
    }
  }

  if (graph.getMaxActivation() < config.rescue_activation_floor) {
    const candidates = graph.getTopByBaseLevel({
      limit: 3,
      nowMs,
      decayD: options.decayD ?? 0.5,
      minHistoryLength: 3
    });
    const fallback = candidates.length > 0
      ? candidates
      : graph.getTopByBaseLevel({
          limit: 3,
          nowMs,
          decayD: options.decayD ?? 0.5,
          minHistoryLength: 1
        });
    if (fallback.length > 0) {
      result.push({
        type: "low_activation_rescue",
        payload: {
          node_ids: fallback.map((node) => node.id)
        },
        source_description: `冷图救援：${fallback.map((node) => node.content.slice(0, 15)).join(", ")}`
      });
    }
  }

  return result;
}
