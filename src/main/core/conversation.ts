import type { ActivitySnapshot, AppConfig } from "@shared/types";
import { CharacterStore } from "./character";
import { LlmRouter } from "./llm";
import { MemoryManager } from "./memory";
import { HistoryStore } from "@main/storage/history";
import { ContextStore } from "@main/storage/context-store";
import type { ToolApprovalHandler, ToolRegistry } from "@main/tools/types";
import type { ChatReplyStreamListener } from "./llm";

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
    photoUrl?: string;
    stream?: ChatReplyStreamListener;
    requestApproval?: ToolApprovalHandler;
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
      requestApproval: input.requestApproval
    });

    const answer = await this.llm.generateChatReply({
      characterPrompt: character.systemPrompt,
      userMessage: input.text,
      recentHistory,
      memoryFacts: this.memoryManager.listFacts(),
      userPhotoUrl: input.photoUrl,
      tools,
      stream: input.stream
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
    try {
      await this.memoryManager.onConversationTurn();
    } catch (error) {
      console.warn("[conversation] memory update skipped:", error);
    }
  }

  async saveProactiveMessage(text: string, activity: ActivitySnapshot | null): Promise<void> {
    await this.commitAssistantMessage({
      text,
      activity,
      proactive: true
    });
  }
}
