import { generateObject } from "ai";
import { z } from "zod";
import type { AppConfig } from "@shared/types";
import type {
  CognitionConfig,
  EmotionWorkspaceState,
  ThoughtBubble
} from "@shared/cognition";
import type { CompanionPaths } from "@main/storage/paths";
import type { AppLogger } from "@main/services/logger";
import type { ModelFactory } from "@main/core/model-factory";
import { resolveOpenAIStoreOption } from "@main/core/provider-utils";
import { readJsonFile, writeJsonFileAtomic } from "@main/storage/fs";

const emotionAnalysisSchema = z.object({
  valence: z.number().min(-1).max(1),
  arousal: z.number().min(0).max(1)
}).strict();

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toIsoString(value: string | number | Date): string {
  if (typeof value === "string") {
    return new Date(value).toISOString();
  }
  return new Date(value).toISOString();
}

interface EmotionStateManagerInput {
  paths: CompanionPaths;
  logger: Pick<AppLogger, "warn">;
  getCognitionConfig: () => CognitionConfig;
  modelFactory?: Pick<ModelFactory, "getCognitionModel">;
  getAppConfig?: () => AppConfig;
  analyzeEmotion?: (text: string) => Promise<{ valence: number; arousal: number }>;
}

// Cold start initializes a calm-lightly-positive baseline to avoid a hard zero state.
export class EmotionStateManager {
  private state: EmotionWorkspaceState;

  constructor(private readonly input: EmotionStateManagerInput) {
    this.state = this.buildColdStartState();
  }

  async load(): Promise<EmotionWorkspaceState> {
    const fallback = this.buildColdStartState();
    const raw = await readJsonFile<unknown>(this.input.paths.cognitionEmotionStatePath, null);
    const parsed = emotionAnalysisSchema.safeParse(
      typeof raw === "object" && raw !== null
        ? {
            valence: (raw as Record<string, unknown>).valence,
            arousal: (raw as Record<string, unknown>).arousal
          }
        : null
    );

    if (!parsed.success) {
      this.state = fallback;
      await this.persist();
      return this.getSnapshot();
    }

    this.state = {
      valence: parsed.data.valence,
      arousal: parsed.data.arousal,
      last_updated: typeof (raw as Record<string, unknown>).last_updated === "string"
        ? toIsoString((raw as Record<string, unknown>).last_updated as string)
        : fallback.last_updated,
      source: typeof (raw as Record<string, unknown>).source === "string"
        ? String((raw as Record<string, unknown>).source)
        : "cold_start"
    };
    return this.getSnapshot();
  }

  getSnapshot(): EmotionWorkspaceState {
    return {
      ...this.state
    };
  }

  setState(input: {
    valence: number;
    arousal: number;
    source: string;
    last_updated?: string | number | Date;
  }): EmotionWorkspaceState {
    this.state = {
      valence: clamp(input.valence, -1, 1),
      arousal: clamp(input.arousal, 0, 1),
      last_updated: toIsoString(input.last_updated ?? Date.now()),
      source: input.source
    };
    return this.getSnapshot();
  }

  computeMatchScore(nodeValence: number): number {
    return clamp(1 - Math.abs(clamp(nodeValence, -1, 1) - this.state.valence), -1, 1);
  }

  async analyzeDialogue(text: string): Promise<EmotionWorkspaceState> {
    const trimmed = text.trim();
    if (!trimmed) {
      return this.getSnapshot();
    }

    const next = this.input.analyzeEmotion
      ? await this.input.analyzeEmotion(trimmed)
      : await this.runModelAnalysis(trimmed);
    const neutral = this.input.getCognitionConfig().emotion.neutral_state;
    const alpha = next.valence >= neutral.valence ? 0.3 : 0.15;
    return this.setState({
      valence: this.state.valence + alpha * (next.valence - this.state.valence),
      arousal: this.state.arousal + alpha * (next.arousal - this.state.arousal),
      source: "dialogue"
    });
  }

  decay(): EmotionWorkspaceState {
    const config = this.input.getCognitionConfig().emotion;
    const neutral = config.neutral_state;
    return this.setState({
      valence: this.state.valence + config.decay_rate * (neutral.valence - this.state.valence),
      arousal: this.state.arousal + config.decay_rate * (neutral.arousal - this.state.arousal),
      source: "decay"
    });
  }

  updateFromBubble(bubble: ThoughtBubble): EmotionWorkspaceState {
    const alpha = 0.2;
    const nextArousal = clamp(
      this.state.arousal + alpha * (Math.min(1, Math.max(Math.abs(bubble.emotional_tone), bubble.activation_peak)) - this.state.arousal),
      0,
      1
    );
    return this.setState({
      valence: this.state.valence + alpha * (clamp(bubble.emotional_tone, -1, 1) - this.state.valence),
      arousal: nextArousal,
      source: "bubble"
    });
  }

  async persist(): Promise<void> {
    await writeJsonFileAtomic(this.input.paths.cognitionEmotionStatePath, this.state);
  }

  private buildColdStartState(): EmotionWorkspaceState {
    const neutral = this.input.getCognitionConfig().emotion.neutral_state;
    return {
      valence: clamp(neutral.valence, -1, 1),
      arousal: clamp(neutral.arousal, 0, 1),
      last_updated: new Date().toISOString(),
      source: "cold_start"
    };
  }

  private async runModelAnalysis(text: string): Promise<{ valence: number; arousal: number }> {
    if (!this.input.modelFactory || !this.input.getAppConfig) {
      return this.input.getCognitionConfig().emotion.neutral_state;
    }

    const result = await generateObject({
      model: this.input.modelFactory.getCognitionModel(),
      providerOptions: resolveOpenAIStoreOption(this.input.getAppConfig(), "cognition"),
      schema: emotionAnalysisSchema,
      prompt: [
        "请根据以下对话文本判断一个简化情绪状态，只返回 JSON。",
        "valence 范围 -1 到 1，负数表示负向，正数表示正向。",
        "arousal 范围 0 到 1，数值越高表示越激动或紧张。",
        text
      ].join("\n")
    });
    const parsed = emotionAnalysisSchema.parse(result.object ?? {});
    return parsed;
  }
}
