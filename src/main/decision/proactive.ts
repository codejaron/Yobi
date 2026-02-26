import type { AppConfig, RuntimeContext } from "@shared/types";
import { CharacterStore } from "@main/core/character";
import { LlmRouter } from "@main/core/llm";
import { MemoryManager } from "@main/core/memory";
import { HistoryStore } from "@main/storage/history";
import { ContextStore } from "@main/storage/context-store";

export type ProactiveTrigger =
  | { type: "silence"; detail: string };

export class ProactiveDecisionEngine {
  constructor(
    private readonly llm: LlmRouter,
    private readonly historyStore: HistoryStore,
    private readonly memoryManager: MemoryManager,
    private readonly characterStore: CharacterStore,
    private readonly contextStore: ContextStore,
    private readonly getConfig: () => AppConfig
  ) {}

  async evaluate(input: {
    trigger: ProactiveTrigger;
  }): Promise<{ speak: boolean; message?: string; reason: string }> {
    const context = this.contextStore.get();
    if (!this.canSpeak(context)) {
      return {
        speak: false,
        reason: "cooldown"
      };
    }

    const config = this.getConfig();
    const character = await this.characterStore.getCharacter(config.characterId);
    const recentHistory = await this.historyStore.getRecent(config.memory.workingSetSize);

    const decision = await this.llm.decideProactive({
      characterPrompt: character.systemPrompt,
      recentHistory,
      memoryFacts: this.memoryManager.listFacts(),
      reason: `${input.trigger.type}: ${input.trigger.detail}`
    });

    if (!decision.shouldSpeak || !decision.message) {
      return {
        speak: false,
        reason: decision.reason
      };
    }

    await this.contextStore.patch({
      lastProactiveAt: new Date().toISOString()
    });

    return {
      speak: true,
      reason: decision.reason,
      message: decision.message
    };
  }

  private canSpeak(context: RuntimeContext): boolean {
    const cooldownMs = this.getConfig().proactive.cooldownMs;
    if (!context.lastProactiveAt) {
      return true;
    }

    return Date.now() - new Date(context.lastProactiveAt).getTime() >= cooldownMs;
  }
}
