import type { ActivitySnapshot, AppConfig } from "@shared/types";
import { CharacterStore } from "./character";
import { LlmRouter } from "./llm";
import { MemoryManager } from "./memory";
import { HistoryStore } from "@main/storage/history";
import { ContextStore } from "@main/storage/context-store";
import type { ToolRegistry } from "@main/tools/types";

export class ConversationEngine {
  constructor(
    private readonly llm: LlmRouter,
    private readonly historyStore: HistoryStore,
    private readonly memoryManager: MemoryManager,
    private readonly characterStore: CharacterStore,
    private readonly contextStore: ContextStore,
    private readonly toolRegistry: ToolRegistry,
    private readonly getConfig: () => AppConfig
  ) {}

  async replyToUser(input: {
    text: string;
    channel: "telegram" | "system";
    activity: ActivitySnapshot | null;
    photoUrl?: string;
  }): Promise<string> {
    const config = this.getConfig();
    await this.historyStore.append("user", input.text, input.channel);
    await this.contextStore.patch({
      lastUserAt: new Date().toISOString()
    });

    const recentHistory = await this.historyStore.getRecent(config.memory.workingSetSize);
    const character = await this.characterStore.getCharacter(config.characterId);
    const tools = this.toolRegistry.getToolSet({
      channel: input.channel,
      userMessage: input.text,
      activity: input.activity
    });

    const answer = await this.llm.generateChatReply({
      characterPrompt: character.systemPrompt,
      userMessage: input.text,
      recentHistory,
      memoryFacts: this.memoryManager.listFacts(),
      activity: input.activity,
      userPhotoUrl: input.photoUrl,
      tools
    });

    return answer;
  }

  async commitAssistantMessage(input: {
    text: string;
    activity: ActivitySnapshot | null;
    proactive?: boolean;
    channel?: "telegram" | "system";
  }): Promise<void> {
    const text = input.text.trim();
    if (!text) {
      return;
    }

    await this.historyStore.append("assistant", text, input.channel ?? "telegram", {
      proactive: input.proactive,
      activitySnapshot: input.activity?.summary
    });
    await this.memoryManager.onConversationTurn();
  }

  async saveProactiveMessage(text: string, activity: ActivitySnapshot | null): Promise<void> {
    await this.commitAssistantMessage({
      text,
      activity,
      proactive: true
    });
  }
}
