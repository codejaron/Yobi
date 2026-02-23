import path from "node:path";
import { existsSync } from "node:fs";
import { app, powerMonitor } from "electron";
import type {
  ActivitySnapshot,
  AppConfig,
  AppStatus,
  CharacterProfile,
  HistoryMessage,
  MemoryFact
} from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import { ConfigStore } from "@main/storage/config";
import { HistoryStore } from "@main/storage/history";
import { MemoryStore } from "@main/storage/memory-store";
import { ContextStore } from "@main/storage/context-store";
import { ReminderStore } from "@main/storage/reminder-store";
import { CharacterStore } from "@main/core/character";
import { LlmRouter } from "@main/core/llm";
import { MemoryManager } from "@main/core/memory";
import { ConversationEngine } from "@main/core/conversation";
import { ActivityMonitor } from "@main/perception/activity";
import { ProactiveDecisionEngine } from "@main/decision/proactive";
import { TelegramChannel } from "@main/channels/telegram";
import type { InboundMessage, OutboundMessage } from "@main/channels/types";
import { parseAssistantOutput, mergeVoiceIntoText } from "@main/services/output-parser";
import { VoiceService } from "@main/services/voice";
import { KeepAwakeService } from "@main/services/keep-awake";
import { ReminderService } from "@main/services/reminders";
import { PetWindowController } from "@main/pet/pet-window";
import { RealtimeVoiceService } from "@main/services/realtime-voice";

interface HistoryQuery {
  query?: string;
  limit?: number;
  offset?: number;
}

export class CompanionRuntime {
  private static readonly CHAT_REPLY_TIMEOUT_MS = 75_000;
  private static readonly PROACTIVE_DECISION_TIMEOUT_MS = 45_000;
  private readonly bootedAt = new Date().toISOString();
  private readonly paths = new CompanionPaths();
  private readonly configStore = new ConfigStore(this.paths);
  private readonly historyStore = new HistoryStore(this.paths);
  private readonly memoryStore = new MemoryStore(this.paths);
  private readonly contextStore = new ContextStore(this.paths);
  private readonly reminderStore = new ReminderStore(this.paths);
  private readonly characterStore = new CharacterStore(this.paths);

  private readonly llm = new LlmRouter(() => this.configStore.getConfig());
  private readonly memoryManager = new MemoryManager(
    this.memoryStore,
    this.historyStore,
    this.llm,
    () => this.configStore.getConfig()
  );

  private readonly conversation = new ConversationEngine(
    this.llm,
    this.historyStore,
    this.memoryManager,
    this.characterStore,
    this.contextStore,
    () => this.configStore.getConfig()
  );

  private readonly activityMonitor = new ActivityMonitor(
    this.llm,
    this.contextStore,
    () => this.configStore.getConfig()
  );

  private readonly proactive = new ProactiveDecisionEngine(
    this.llm,
    this.historyStore,
    this.memoryManager,
    this.characterStore,
    this.contextStore,
    () => this.configStore.getConfig()
  );

  private readonly telegram = new TelegramChannel(() => this.configStore.getConfig());
  private readonly voiceService = new VoiceService();
  private readonly keepAwake = new KeepAwakeService();
  private readonly pet = new PetWindowController();
  private readonly realtimeVoice = new RealtimeVoiceService();
  private readonly reminderService = new ReminderService(this.reminderStore, {
    sendReminder: async (item) => {
      await this.telegram.send({
        kind: "text",
        text: `⏰ 提醒：${item.text}`
      });
    }
  });

  private statusListeners = new Set<(status: AppStatus) => void>();
  private silenceTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastSilenceHandledAt: string | null = null;
  private lastActivity: ActivitySnapshot | null = null;
  private screenLocked = false;
  private idlePaused = false;

  async init(): Promise<void> {
    this.paths.ensureLayout();
    await this.configStore.init();
    await this.memoryStore.init();
    await this.contextStore.init();
    await this.reminderStore.init();
    await this.characterStore.init();
  }

  async start(): Promise<void> {
    this.bindPowerMonitor();
    await this.reminderService.init();
    await this.startTelegram();

    this.activityMonitor.onChange(async ({ snapshot }) => {
      try {
        const previous = this.lastActivity;
        this.lastActivity = snapshot;

        await this.handleProactive({
          trigger: {
            type: "activity-switch",
            detail: snapshot.summary
          },
          activity: snapshot
        });

        if (previous) {
          const gap =
            new Date(snapshot.changedAt).getTime() - new Date(previous.changedAt).getTime();

          if (gap > this.configStore.getConfig().proactive.comebackGraceMs) {
            await this.handleProactive({
              trigger: {
                type: "comeback",
                detail: "检测到用户重新活跃"
              },
              activity: snapshot
            });
          }
        }

        await this.emitStatus();
      } catch (error) {
        console.warn("Activity callback failed:", error);
      }
    });

    this.keepAwake.apply(this.getConfig().background.keepAwake);
    this.syncPetWindow();
    this.syncRealtimeVoice();
    this.idlePaused =
      powerMonitor.getSystemIdleTime() >= this.getConfig().perception.idlePauseSeconds;
    await this.syncPerceptionState();

    this.startSilenceLoop();
    this.startIdleLoop();
    await this.emitStatus();
  }

  async stop(): Promise<void> {
    this.activityMonitor.stop();

    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }

    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }

    this.keepAwake.stop();
    this.pet.close();
    this.realtimeVoice.stop();
    await this.telegram.stop();
  }

  onStatus(listener: (status: AppStatus) => void): () => void {
    this.statusListeners.add(listener);
    void this.emitStatus();

    return () => {
      this.statusListeners.delete(listener);
    };
  }

  getConfig(): AppConfig {
    return this.configStore.getConfig();
  }

  async saveConfig(nextConfig: AppConfig): Promise<AppConfig> {
    const saved = await this.configStore.saveConfig(nextConfig);
    await this.restartTelegram();
    this.keepAwake.apply(saved.background.keepAwake);
    this.syncPetWindow();
    this.syncRealtimeVoice();
    await this.syncPerceptionState();
    this.startSilenceLoop();
    this.startIdleLoop();
    await this.emitStatus();
    return saved;
  }

  async getCharacter(characterId: string): Promise<CharacterProfile> {
    return this.characterStore.getCharacter(characterId);
  }

  async saveCharacter(profile: CharacterProfile): Promise<void> {
    await this.characterStore.saveCharacter(profile);
  }

  async getHistory(options: HistoryQuery): Promise<HistoryMessage[]> {
    return this.historyStore.search(options);
  }

  async getMemoryFacts(): Promise<MemoryFact[]> {
    return this.memoryManager.listFacts();
  }

  async upsertMemoryFact(input: {
    id?: string;
    content: string;
    confidence: number;
  }): Promise<MemoryFact> {
    return this.memoryManager.createOrUpdateFact(input);
  }

  async deleteMemoryFact(id: string): Promise<void> {
    await this.memoryManager.deleteFact(id);
  }

  async getStatus(): Promise<AppStatus> {
    return this.collectStatus();
  }

  private async startTelegram(): Promise<void> {
    await this.telegram.start(async (inbound) => {
      try {
        await this.handleInbound(inbound);
      } catch (error) {
        const message =
          error instanceof Error ? `处理消息时出错：${error.message}` : "处理消息时出现未知错误。";
        await this.telegram.send({
          kind: "text",
          text: message
        });
      }
      await this.emitStatus();
    });
  }

  private async restartTelegram(): Promise<void> {
    await this.telegram.stop();
    await this.startTelegram();
  }

  private async handleInbound(inbound: InboundMessage): Promise<void> {
    console.info("[runtime] Inbound Telegram message", {
      kind: inbound.kind,
      fromUserId: inbound.fromUserId,
      preview: inbound.text.slice(0, 80)
    });

    if (inbound.kind === "text") {
      const handled = await this.tryHandleTelegramCommand(inbound.text);
      if (handled) {
        return;
      }
    }

    if (inbound.kind === "photo" && !this.getConfig().messaging.allowPhotoInput) {
      await this.telegram.send({
        kind: "text",
        text: "当前已关闭图片输入理解，你可以在设置中开启『允许图片输入』。"
      });
      return;
    }

    const reply = await this.withTimeout(
      this.conversation.replyToUser({
        text: inbound.text,
        channel: "telegram",
        activity: this.activityMonitor.getCurrentSnapshot(),
        photoUrl: inbound.photoUrl
      }),
      CompanionRuntime.CHAT_REPLY_TIMEOUT_MS,
      "LLM 回复超时"
    );

    console.info("[runtime] LLM reply generated", {
      length: reply.length
    });

    await this.deliverAssistantOutput({
      rawText: reply,
      activity: this.activityMonitor.getCurrentSnapshot(),
      proactive: false
    });
  }

  private async tryHandleTelegramCommand(text: string): Promise<boolean> {
    const command = text.trim();

    if (/^\/eyes\s+off$/i.test(command)) {
      await this.contextStore.patch({ eyesCommandEnabled: false });
      await this.syncPerceptionState();
      await this.telegram.send({
        kind: "text",
        text: "已关闭屏幕感知（/eyes on 可恢复）。"
      });
      return true;
    }

    if (/^\/eyes\s+on$/i.test(command)) {
      await this.contextStore.patch({ eyesCommandEnabled: true });
      await this.syncPerceptionState();
      await this.telegram.send({
        kind: "text",
        text: "已恢复屏幕感知。"
      });
      return true;
    }

    if (/^\/reminders$/i.test(command)) {
      const items = this.reminderService.list();
      if (items.length === 0) {
        await this.telegram.send({
          kind: "text",
          text: "当前没有待提醒事项。"
        });
        return true;
      }

      const lines = items
        .slice(0, 30)
        .map((item) => `- ${item.id.slice(0, 8)} · ${new Date(item.at).toLocaleString()} · ${item.text}`)
        .join("\n");

      await this.telegram.send({
        kind: "text",
        text: `待提醒事项（最多显示 30 条）:\n${lines}`
      });
      return true;
    }

    const cancelMatch = command.match(/^\/cancel\s+([a-zA-Z0-9-]+)/i);
    if (cancelMatch?.[1]) {
      const token = cancelMatch[1];
      const target = this.reminderService
        .list()
        .find((item) => item.id === token || item.id.startsWith(token));

      if (!target) {
        await this.telegram.send({
          kind: "text",
          text: "没有找到对应提醒 ID。可先用 /reminders 查看。"
        });
        return true;
      }

      await this.reminderService.cancel(target.id);
      await this.telegram.send({
        kind: "text",
        text: `已取消提醒：${target.text}`
      });
      return true;
    }

    return false;
  }

  private async deliverAssistantOutput(input: {
    rawText: string;
    activity: ActivitySnapshot | null;
    proactive: boolean;
  }): Promise<void> {
    const config = this.getConfig();
    const parsed = parseAssistantOutput(input.rawText);

    const reminders = await this.reminderService.createBatch(
      parsed.reminders.map((item) => ({ text: item.text, at: item.time }))
    );

    const messages: OutboundMessage[] = [];
    const historyTextPieces: string[] = [];
    const degradedVoiceTexts: string[] = [];

    if (config.messaging.allowVoiceMessages && parsed.voiceTexts.length > 0) {
      for (const voiceText of parsed.voiceTexts) {
        try {
          const audio = await this.voiceService.synthesize({
            text: voiceText,
            config: {
              voice: config.voice.ttsVoice,
              rate: config.voice.ttsRate,
              pitch: config.voice.ttsPitch,
              proxy: config.voice.proxy,
              requestTimeoutMs: config.voice.requestTimeoutMs,
              retryCount: config.voice.retryCount
            }
          });

          messages.push({
            kind: "voice",
            audio,
            filename: "yobi-voice.mp3"
          });
          historyTextPieces.push(`[语音] ${voiceText}`);
        } catch (error) {
          console.warn("Voice synthesis failed:", error);
          degradedVoiceTexts.push(voiceText);
        }
      }
    } else if (parsed.voiceTexts.length > 0) {
      degradedVoiceTexts.push(...parsed.voiceTexts);
    }

    const textPayload = [...degradedVoiceTexts, parsed.visibleText].filter(Boolean).join("\\n");
    if (textPayload) {
      messages.push({
        kind: "text",
        text: textPayload
      });
      historyTextPieces.push(textPayload);
    }

    if (reminders.length > 0) {
      const summary = reminders
        .map((item) => `${item.id.slice(0, 8)} · ${new Date(item.at).toLocaleString()} · ${item.text}`)
        .join("\n");
      messages.push({
        kind: "text",
        text: `我帮你记下这些提醒啦:\n${summary}`
      });
      historyTextPieces.push(`[提醒] ${reminders.map((item) => item.text).join("; ")}`);
    }

    if (messages.length === 0) {
      const fallback = mergeVoiceIntoText(parsed);
      if (fallback) {
        messages.push({ kind: "text", text: fallback });
        historyTextPieces.push(fallback);
      }
    }

    for (const message of messages) {
      await this.telegram.send(message);
    }

    if (parsed.emotions.length > 0) {
      const emotion = parsed.emotions.at(-1) ?? "idle";
      this.pet.emitEvent({
        type: "emotion",
        value: emotion
      });
    }

    if (messages.length > 0) {
      this.pet.emitEvent({
        type: "talking",
        value: "talking"
      });
    }

    await this.conversation.commitAssistantMessage({
      text: historyTextPieces.join("\n"),
      activity: input.activity,
      proactive: input.proactive
    });
  }

  private startSilenceLoop(): void {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
    }

    this.silenceTimer = setInterval(() => {
      void this.checkSilence();
    }, 60_000);
  }

  private startIdleLoop(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
    }

    this.idleTimer = setInterval(() => {
      const threshold = this.getConfig().perception.idlePauseSeconds;
      const idleSeconds = powerMonitor.getSystemIdleTime();
      const nextIdlePaused = idleSeconds >= threshold;
      if (nextIdlePaused === this.idlePaused) {
        return;
      }

      this.idlePaused = nextIdlePaused;
      void this.syncPerceptionState();
      void this.emitStatus();
    }, 15_000);
  }

  private bindPowerMonitor(): void {
    powerMonitor.removeAllListeners("lock-screen");
    powerMonitor.removeAllListeners("unlock-screen");
    powerMonitor.removeAllListeners("suspend");
    powerMonitor.removeAllListeners("resume");

    powerMonitor.on("lock-screen", () => {
      this.screenLocked = true;
      void this.syncPerceptionState();
      void this.emitStatus();
    });

    powerMonitor.on("unlock-screen", () => {
      this.screenLocked = false;
      void this.syncPerceptionState();
      void this.emitStatus();
    });

    powerMonitor.on("suspend", () => {
      this.screenLocked = true;
      void this.syncPerceptionState();
      void this.emitStatus();
    });

    powerMonitor.on("resume", () => {
      this.screenLocked = false;
      void this.syncPerceptionState();
      void this.emitStatus();
    });
  }

  private async checkSilence(): Promise<void> {
    const context = this.contextStore.get();
    if (!context.lastUserAt) {
      return;
    }

    const now = Date.now();
    const silenceMs = now - new Date(context.lastUserAt).getTime();
    const threshold = this.configStore.getConfig().proactive.silenceThresholdMs;

    if (silenceMs < threshold) {
      this.lastSilenceHandledAt = null;
      return;
    }

    const currentWindow = this.lastActivity;
    if (!currentWindow) {
      return;
    }

    if (this.lastSilenceHandledAt === context.lastUserAt) {
      return;
    }

    this.lastSilenceHandledAt = context.lastUserAt;
    await this.handleProactive({
      trigger: {
        type: "silence",
        detail: `用户已沉默 ${Math.floor(silenceMs / 60000)} 分钟`
      },
      activity: currentWindow
    });
    await this.emitStatus();
  }

  private async handleProactive(input: {
    trigger: { type: "activity-switch" | "silence" | "comeback"; detail: string };
    activity: ActivitySnapshot | null;
  }): Promise<void> {
    const decision = await this.withTimeout(
      this.proactive.evaluate({
        trigger: input.trigger,
        activity: input.activity
      }),
      CompanionRuntime.PROACTIVE_DECISION_TIMEOUT_MS,
      "主动消息决策超时"
    );

    if (!decision.speak || !decision.message) {
      return;
    }

    await this.deliverAssistantOutput({
      rawText: decision.message,
      activity: input.activity,
      proactive: true
    });
  }

  private async syncPerceptionState(): Promise<void> {
    const shouldRun = this.shouldRunPerception();
    const running = this.activityMonitor.isRunning();

    if (shouldRun && !running) {
      await this.activityMonitor.start();
      return;
    }

    if (!shouldRun && running) {
      this.activityMonitor.stop();
    }
  }

  private shouldRunPerception(): boolean {
    const config = this.getConfig();
    const context = this.contextStore.get();

    return (
      config.perception.enabled &&
      context.eyesCommandEnabled &&
      !this.screenLocked &&
      !this.idlePaused
    );
  }

  private syncPetWindow(): void {
    const config = this.getConfig().pet;
    if (!config.enabled) {
      this.pet.close();
      return;
    }

    let modelDir = path.isAbsolute(config.modelDir)
      ? config.modelDir
      : path.join(app.getAppPath(), config.modelDir);

    if (!existsSync(modelDir)) {
      const legacyDir = path.join(app.getAppPath(), "haru_greeter_pro_jp");
      const newDefaultDir = path.join(app.getAppPath(), "resources", "models", "haru_greeter_pro_jp");
      if (modelDir === legacyDir && existsSync(newDefaultDir)) {
        modelDir = newDefaultDir;
      }
    }

    this.pet.open({
      modelDir,
      alwaysOnTop: config.alwaysOnTop
    });
  }

  private syncRealtimeVoice(): void {
    if (this.getConfig().realtimeVoice.enabled) {
      this.realtimeVoice.start();
      return;
    }

    this.realtimeVoice.stop();
  }

  private async collectStatus(): Promise<AppStatus> {
    return {
      bootedAt: this.bootedAt,
      telegramConnected: this.telegram.isConnected(),
      lastActivitySummary: this.contextStore.get().lastActivitySummary,
      lastUserAt: this.contextStore.get().lastUserAt,
      lastProactiveAt: this.contextStore.get().lastProactiveAt,
      historyCount: await this.historyStore.count(),
      memoryFacts: this.memoryManager.listFacts().length,
      perceptionRunning: this.activityMonitor.isRunning(),
      keepAwakeActive: this.keepAwake.isActive(),
      pendingReminders: this.reminderService.count(),
      petOnline: this.pet.isOnline()
    };
  }

  private async emitStatus(): Promise<void> {
    if (this.statusListeners.size === 0) {
      return;
    }

    const status = await this.collectStatus();
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label}（${Math.floor(timeoutMs / 1000)} 秒）`));
      }, timeoutMs);

      promise
        .then((value) => resolve(value))
        .catch((error) => reject(error))
        .finally(() => clearTimeout(timer));
    });
  }
}

export const runtime = new CompanionRuntime();

app.on("before-quit", () => {
  void runtime.stop();
});
