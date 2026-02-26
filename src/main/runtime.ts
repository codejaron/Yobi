import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { app, powerMonitor, systemPreferences } from "electron";
import type {
  ActivitySnapshot,
  AppConfig,
  AppStatus,
  CharacterProfile,
  CommandApprovalDecision,
  ConsoleChatEvent,
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
import { VoiceProviderRouter } from "@main/services/voice-router";
import { KeepAwakeService } from "@main/services/keep-awake";
import { ReminderService } from "@main/services/reminders";
import { PetWindowController } from "@main/pet/pet-window";
import { RealtimeVoiceService } from "@main/services/realtime-voice";
import { GlobalPetPushToTalkService, type GlobalPttPhase } from "@main/services/global-ptt";
import { createDefaultToolRegistry } from "@main/tools/bootstrap";
import type { ToolApprovalRequest } from "@main/tools/types";

interface HistoryQuery {
  query?: string;
  limit?: number;
  offset?: number;
}

interface PendingConsoleApproval {
  requestId: string;
  resolve: (decision: CommandApprovalDecision) => void;
}

type CommandSource = "telegram" | "console";

interface CommandHandleResult {
  handled: boolean;
  responseText?: string;
}

type MacPermissionState = "granted" | "denied" | "unknown";

export class CompanionRuntime {
  private static readonly CHAT_REPLY_TIMEOUT_MS = 5 * 60_000;
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
  private readonly toolRegistry = createDefaultToolRegistry(() => this.configStore.getConfig());
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
    this.toolRegistry,
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
  private readonly voiceRouter = new VoiceProviderRouter(
    () => this.configStore.getConfig(),
    this.voiceService
  );
  private readonly keepAwake = new KeepAwakeService();
  private readonly pet = new PetWindowController();
  private readonly realtimeVoice = new RealtimeVoiceService();
  private readonly globalPtt = new GlobalPetPushToTalkService();
  private readonly reminderService = new ReminderService(this.reminderStore, {
    sendReminder: async (item) => {
      await this.telegram.send({
        kind: "text",
        text: `⏰ 提醒：${item.text}`
      });
    }
  });

  private statusListeners = new Set<(status: AppStatus) => void>();
  private consoleChatListeners = new Set<(event: ConsoleChatEvent) => void>();
  private pendingConsoleApprovals = new Map<string, PendingConsoleApproval>();
  private petPttRecording = false;
  private silenceTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastSilenceHandledAt: string | null = null;
  private lastActivity: ActivitySnapshot | null = null;
  private screenLocked = false;
  private idlePaused = false;
  private promptedAccessibilityPermission = false;
  private promptedGlobalPttPermission = false;
  private macAccessibilityPermission: MacPermissionState = "unknown";
  private macScreenRecordingPermission: MacPermissionState = "unknown";

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
    this.refreshMacPerceptionPermissions({
      promptIfMissing: true
    });
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
    await this.syncGlobalPetPushToTalk();
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
    this.globalPtt.stop();
    this.petPttRecording = false;
    this.realtimeVoice.stop();
    for (const pending of this.pendingConsoleApprovals.values()) {
      pending.resolve("deny");
    }
    this.pendingConsoleApprovals.clear();
    await this.toolRegistry.dispose();
    await this.telegram.stop();
  }

  onStatus(listener: (status: AppStatus) => void): () => void {
    this.statusListeners.add(listener);
    void this.emitStatus();

    return () => {
      this.statusListeners.delete(listener);
    };
  }

  onConsoleChatEvent(listener: (event: ConsoleChatEvent) => void): () => void {
    this.consoleChatListeners.add(listener);

    return () => {
      this.consoleChatListeners.delete(listener);
    };
  }

  getConfig(): AppConfig {
    return this.configStore.getConfig();
  }

  async importPetModelDirectory(sourceDir: string): Promise<{ modelDir: string }> {
    const resolvedSourceDir = path.resolve(sourceDir);

    let sourceStat;
    try {
      sourceStat = await stat(resolvedSourceDir);
    } catch {
      throw new Error("选择的模型目录不存在。");
    }

    if (!sourceStat.isDirectory()) {
      throw new Error("请选择模型文件夹，而不是文件。");
    }

    const containsModelFile = await this.containsModel3JsonFile(resolvedSourceDir);
    if (!containsModelFile) {
      throw new Error("所选目录内未找到 .model3.json 文件。");
    }

    await mkdir(this.paths.modelsDir, {
      recursive: true
    });

    const managedModelsDir = path.resolve(this.paths.modelsDir);
    if (resolvedSourceDir === managedModelsDir) {
      throw new Error("请选择具体模型文件夹，不要选择 models 根目录。");
    }

    const baseName = this.normalizeModelDirectoryName(path.basename(resolvedSourceDir));
    let targetDir = path.join(this.paths.modelsDir, baseName);
    if (existsSync(targetDir)) {
      targetDir = path.join(this.paths.modelsDir, `${baseName}-${Date.now()}`);
    }

    await cp(resolvedSourceDir, targetDir, {
      recursive: true,
      force: true
    });

    const copiedContainsModelFile = await this.containsModel3JsonFile(targetDir);
    if (!copiedContainsModelFile) {
      throw new Error("模型导入失败：复制后未找到 .model3.json 文件。");
    }

    return {
      modelDir: targetDir
    };
  }

  async saveConfig(nextConfig: AppConfig): Promise<AppConfig> {
    const previousConfig = this.configStore.getConfig();
    const saved = await this.configStore.saveConfig(nextConfig);
    const petConfigChanged = this.hasPetConfigChanged(previousConfig, saved);
    const globalPttConfigChanged = this.hasGlobalPttConfigChanged(previousConfig, saved);
    const keepAwakeChanged =
      previousConfig.background.keepAwake !== saved.background.keepAwake;
    const realtimeVoiceChanged = this.hasRealtimeVoiceConfigChanged(previousConfig, saved);

    if (keepAwakeChanged) {
      this.keepAwake.apply(saved.background.keepAwake);
    }

    if (petConfigChanged) {
      this.syncPetWindow();
    }

    if (petConfigChanged || globalPttConfigChanged) {
      await this.syncGlobalPetPushToTalk();
    }

    if (realtimeVoiceChanged) {
      this.syncRealtimeVoice();
    }

    this.startSilenceLoop();
    this.startIdleLoop();
    await this.emitStatus();

    void this.refreshRuntimeAfterConfigSave(previousConfig, saved);
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

  async clearHistory(): Promise<void> {
    await this.historyStore.clear();
    await this.emitStatus();
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

  async clearMemoryFacts(): Promise<void> {
    await this.memoryStore.clearFacts();
    await this.emitStatus();
  }

  getMemoryFilePath(): string {
    return this.paths.memoryPath;
  }

  async getStatus(): Promise<AppStatus> {
    return this.collectStatus();
  }

  async getConsoleChatHistory(input?: {
    cursor?: string;
    limit?: number;
  }): Promise<{
    items: HistoryMessage[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    return this.historyStore.searchByCursor({
      limit: input?.limit ?? 20,
      beforeId: input?.cursor,
      roles: ["user", "assistant"]
    });
  }

  async startConsoleChat(text: string): Promise<{ requestId: string }> {
    const normalized = text.trim();
    if (!normalized) {
      throw new Error("消息不能为空");
    }

    const requestId = randomUUID();
    queueMicrotask(() => {
      void this.runConsoleChatRequest(requestId, normalized);
    });

    return {
      requestId
    };
  }

  async resolveConsoleApproval(input: {
    approvalId: string;
    decision: CommandApprovalDecision;
  }): Promise<{ accepted: boolean }> {
    const pending = this.pendingConsoleApprovals.get(input.approvalId);
    if (!pending) {
      return {
        accepted: false
      };
    }

    this.pendingConsoleApprovals.delete(input.approvalId);
    pending.resolve(input.decision);
    this.emitConsoleChatEvent({
      requestId: pending.requestId,
      type: "approval-decision",
      approvalId: input.approvalId,
      decision: input.decision,
      timestamp: new Date().toISOString()
    });

    return {
      accepted: true
    };
  }

  async chatFromPet(text: string): Promise<{ replyText: string }> {
    const normalized = text.trim();
    if (!normalized) {
      return { replyText: "" };
    }

    const activity = this.activityMonitor.getCurrentSnapshot();

    this.pet.emitEvent({
      type: "thinking",
      value: "start"
    });

    let rawReply = "";
    try {
      rawReply = await this.withTimeout(
        this.conversation.replyToUser({
          text: normalized,
          channel: "system",
          activity
        }),
        CompanionRuntime.CHAT_REPLY_TIMEOUT_MS,
        "LLM 回复超时"
      );
    } finally {
      this.pet.emitEvent({
        type: "thinking",
        value: "stop"
      });
    }

    const delivered = await this.deliverAssistantOutput({
      rawText: rawReply,
      activity,
      proactive: false,
      destination: "pet",
      historyChannel: "system"
    });

    await this.emitStatus();
    return {
      replyText: delivered.displayText
    };
  }

  async transcribeVoiceInput(input: {
    pcm16Base64?: string;
    sampleRate?: number;
  }): Promise<{
    text: string;
  }> {
    const pcm16Base64 = typeof input.pcm16Base64 === "string" ? input.pcm16Base64.trim() : "";
    if (!pcm16Base64) {
      throw new Error("录音数据为空。");
    }

    if (!this.voiceRouter.isAlibabaSttReady()) {
      throw new Error("阿里语音识别未启用，请在设置里先打开开关并填写 API Key。");
    }

    let pcm: Buffer;
    try {
      pcm = Buffer.from(pcm16Base64, "base64");
    } catch {
      throw new Error("录音数据格式不合法。");
    }

    if (pcm.length === 0) {
      throw new Error("录音数据为空。");
    }

    const sampleRate = Number.isFinite(input.sampleRate) ? Number(input.sampleRate) : 16_000;
    const text = await this.voiceRouter.transcribePcm16({
      pcm,
      sampleRate
    });

    return {
      text
    };
  }

  async transcribeAndSendFromPet(input: {
    pcm16Base64?: string;
    sampleRate?: number;
  }): Promise<{
    sent: boolean;
    text: string;
    replyText?: string;
    message?: string;
  }> {
    if (!this.voiceRouter.isAlibabaSttReady()) {
      return {
        sent: false,
        text: "",
        message: "阿里语音识别未启用"
      };
    }

    const transcribed = await this.transcribeVoiceInput(input);
    const text = transcribed.text.trim();
    if (!text) {
      return {
        sent: false,
        text: "",
        message: "未识别到有效语音"
      };
    }

    const replied = await this.chatFromPet(text);
    return {
      sent: true,
      text,
      replyText: replied.replyText
    };
  }

  private async runConsoleChatRequest(requestId: string, text: string): Promise<void> {
    const activity = this.activityMonitor.getCurrentSnapshot();
    this.emitConsoleChatEvent({
      requestId,
      type: "thinking",
      state: "start",
      timestamp: new Date().toISOString()
    });

    try {
      const commandResult = await this.tryHandleChatCommand(text, "console");
      if (commandResult.handled) {
        const displayText = commandResult.responseText?.trim() || "命令已执行。";
        this.emitConsoleChatEvent({
          requestId,
          type: "final",
          rawText: displayText,
          displayText,
          timestamp: new Date().toISOString()
        });
        return;
      }

      const rawReply = await this.withTimeout(
        this.conversation.replyToUser({
          text,
          channel: "system",
          activity,
          stream: {
            onReasoningDelta: (delta) => {
              this.emitConsoleChatEvent({
                requestId,
                type: "reasoning-delta",
                delta,
                timestamp: new Date().toISOString()
              });
            },
            onTextDelta: (delta) => {
              this.emitConsoleChatEvent({
                requestId,
                type: "text-delta",
                delta,
                timestamp: new Date().toISOString()
              });
            },
            onToolCall: (payload) => {
              this.emitConsoleChatEvent({
                requestId,
                type: "tool-call",
                toolCallId: payload.toolCallId,
                toolName: payload.toolName,
                input: payload.input,
                timestamp: new Date().toISOString()
              });
            },
            onToolResult: (payload) => {
              this.emitConsoleChatEvent({
                requestId,
                type: "tool-result",
                toolCallId: payload.toolCallId,
                toolName: payload.toolName,
                input: payload.input,
                output: payload.output,
                error: payload.error,
                success: payload.success,
                timestamp: new Date().toISOString()
              });
            }
          },
          requestApproval: (request) => this.requestConsoleApproval(requestId, request)
        }),
        CompanionRuntime.CHAT_REPLY_TIMEOUT_MS,
        "LLM 回复超时"
      );

      const delivered = await this.deliverAssistantOutput({
        rawText: rawReply,
        activity,
        proactive: false,
        destination: "console",
        historyChannel: "system"
      });

      this.emitConsoleChatEvent({
        requestId,
        type: "final",
        rawText: rawReply,
        displayText: delivered.displayText,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "处理消息时出现未知错误。";
      this.emitConsoleChatEvent({
        requestId,
        type: "error",
        message,
        timestamp: new Date().toISOString()
      });
    } finally {
      this.flushPendingApprovalsForRequest(requestId);
      this.emitConsoleChatEvent({
        requestId,
        type: "thinking",
        state: "stop",
        timestamp: new Date().toISOString()
      });
      await this.emitStatus();
    }
  }

  private async requestConsoleApproval(
    requestId: string,
    request: ToolApprovalRequest
  ): Promise<CommandApprovalDecision> {
    if (this.consoleChatListeners.size === 0) {
      return "deny";
    }

    const approvalId = randomUUID();
    this.emitConsoleChatEvent({
      requestId,
      type: "approval-request",
      approvalId,
      toolName: request.toolName,
      description: request.description,
      timestamp: new Date().toISOString()
    });

    return new Promise<CommandApprovalDecision>((resolve) => {
      this.pendingConsoleApprovals.set(approvalId, {
        requestId,
        resolve
      });
    });
  }

  private flushPendingApprovalsForRequest(requestId: string): void {
    for (const [approvalId, pending] of this.pendingConsoleApprovals.entries()) {
      if (pending.requestId !== requestId) {
        continue;
      }

      this.pendingConsoleApprovals.delete(approvalId);
      pending.resolve("deny");
    }
  }

  private async startTelegram(): Promise<void> {
    await this.telegram.start(async (inbound) => {
      try {
        await this.handleInbound(inbound);
      } catch (error) {
        console.error("[runtime] handleInbound failed:", error);
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
      const commandResult = await this.tryHandleChatCommand(inbound.text, "telegram");
      if (commandResult.handled) {
        if (commandResult.responseText) {
          await this.telegram.send({
            kind: "text",
            text: commandResult.responseText
          });
        }
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

    this.pet.emitEvent({
      type: "thinking",
      value: "start"
    });

    let reply = "";
    try {
      reply = await this.withTimeout(
        this.conversation.replyToUser({
          text: inbound.text,
          channel: "telegram",
          activity: this.activityMonitor.getCurrentSnapshot(),
          photoUrl: inbound.photoUrl
        }),
        CompanionRuntime.CHAT_REPLY_TIMEOUT_MS,
        "LLM 回复超时"
      );
    } finally {
      this.pet.emitEvent({
        type: "thinking",
        value: "stop"
      });
    }

    console.info("[runtime] LLM reply generated", {
      length: reply.length
    });

    await this.deliverAssistantOutput({
      rawText: reply,
      activity: this.activityMonitor.getCurrentSnapshot(),
      proactive: false
    });
  }

  private buildCommandHelpText(): string {
    return [
      "可用命令：",
      "/help - 查看命令说明",
      "/eyes - 查看桌面感知状态",
      "/eyes on - 打开桌面感知命令",
      "/eyes off - 关闭桌面感知命令",
      "/reminders - 查看待提醒事项",
      "/cancel <提醒ID前缀> - 取消提醒"
    ].join("\n");
  }

  private async tryHandleChatCommand(
    text: string,
    _source: CommandSource
  ): Promise<CommandHandleResult> {
    const command = text.trim();

    if (!command.startsWith("/")) {
      return {
        handled: false
      };
    }

    if (/^\/help$/i.test(command)) {
      return {
        handled: true,
        responseText: this.buildCommandHelpText()
      };
    }

    if (/^\/eyes(\s+status)?$/i.test(command)) {
      const config = this.getConfig();
      const context = this.contextStore.get();
      const issues: string[] = [];
      this.refreshMacPerceptionPermissions();

      if (!config.perception.enabled) {
        issues.push("设置页中的『启用桌面感知』为关闭状态");
      }
      if (!context.eyesCommandEnabled) {
        issues.push("命令开关为 OFF（输入 /eyes on 恢复）");
      }
      if (this.screenLocked) {
        issues.push("系统处于锁屏/休眠状态");
      }
      if (this.idlePaused) {
        issues.push(`系统空闲超过 ${config.perception.idlePauseSeconds} 秒`);
      }

      const running = this.activityMonitor.isRunning();
      const snapshot = this.activityMonitor.getCurrentSnapshot();
      const lines = [
        `桌面感知状态：${running ? "运行中" : "已暂停"}`,
        `全局开关：${config.perception.enabled ? "ON" : "OFF"}`,
        `/eyes 开关：${context.eyesCommandEnabled ? "ON" : "OFF"}`,
        `轮询间隔：${config.perception.pollIntervalMs} ms`,
        `截图宽度/质量：${config.perception.screenshotMaxWidth}px / ${config.perception.screenshotQuality}`,
        `空闲暂停阈值：${config.perception.idlePauseSeconds} 秒`,
        `最近快照应用：${snapshot?.app ?? "(暂无)"}`,
        `最近快照标题：${snapshot?.title ?? "(暂无)"}`,
        `最近快照时间：${snapshot?.changedAt ?? "(暂无)"}`
      ];

      if (issues.length > 0) {
        lines.push(`暂停原因：${issues.join("；")}`);
      }

      lines.push("命令：/eyes on | /eyes off");

      return {
        handled: true,
        responseText: lines.join("\n")
      };
    }

    if (/^\/eyes\s+off$/i.test(command)) {
      await this.contextStore.patch({ eyesCommandEnabled: false });
      await this.syncPerceptionState();
      return {
        handled: true,
        responseText: "已关闭屏幕感知（/eyes on 可恢复）。"
      };
    }

    if (/^\/eyes\s+on$/i.test(command)) {
      await this.contextStore.patch({ eyesCommandEnabled: true });
      await this.syncPerceptionState();
      return {
        handled: true,
        responseText: "已恢复屏幕感知。"
      };
    }

    if (/^\/reminders$/i.test(command)) {
      const items = this.reminderService.list();
      if (items.length === 0) {
        return {
          handled: true,
          responseText: "当前没有待提醒事项。"
        };
      }

      const lines = items
        .slice(0, 30)
        .map((item) => `- ${item.id.slice(0, 8)} · ${new Date(item.at).toLocaleString()} · ${item.text}`)
        .join("\n");

      return {
        handled: true,
        responseText: `待提醒事项（最多显示 30 条）:\n${lines}`
      };
    }

    if (/^\/cancel$/i.test(command)) {
      return {
        handled: true,
        responseText: "用法：/cancel <提醒ID前缀>\n可先用 /reminders 查看。"
      };
    }

    const cancelMatch = command.match(/^\/cancel\s+([a-zA-Z0-9-]+)/i);
    if (cancelMatch?.[1]) {
      const token = cancelMatch[1];
      const target = this.reminderService
        .list()
        .find((item) => item.id === token || item.id.startsWith(token));

      if (!target) {
        return {
          handled: true,
          responseText: "没有找到对应提醒 ID。可先用 /reminders 查看。"
        };
      }

      await this.reminderService.cancel(target.id);
      return {
        handled: true,
        responseText: `已取消提醒：${target.text}`
      };
    }

    return {
      handled: true,
      responseText: `未识别命令：${command.split(/\s+/, 1)[0]}\n输入 /help 查看可用命令。`
    };
  }

  private async deliverAssistantOutput(input: {
    rawText: string;
    activity: ActivitySnapshot | null;
    proactive: boolean;
    destination?: "telegram" | "pet" | "console";
    historyChannel?: HistoryMessage["channel"];
  }): Promise<{ displayText: string }> {
    const config = this.getConfig();
    const destination = input.destination ?? "telegram";
    const sendToTelegram = destination === "telegram";
    const emitPetEvents = destination === "telegram" || destination === "pet" || destination === "console";
    const parsed = parseAssistantOutput(input.rawText);

    const reminders = await this.reminderService.createBatch(
      parsed.reminders.map((item) => ({ text: item.text, at: item.time }))
    );

    const messages: OutboundMessage[] = [];
    const historyTextPieces: string[] = [];
    const visibleTextPieces: string[] = [];
    const degradedVoiceTexts: string[] = [];
    const synthesizedVoiceByText = new Map<string, Buffer>();
    const ttsConfig = {
      voice: config.voice.ttsVoice,
      rate: config.voice.ttsRate,
      pitch: config.voice.ttsPitch,
      requestTimeoutMs: config.voice.requestTimeoutMs,
      retryCount: config.voice.retryCount
    };

    if (sendToTelegram && config.messaging.allowVoiceMessages && parsed.voiceTexts.length > 0) {
      for (const voiceText of parsed.voiceTexts) {
        try {
          const audio = await this.voiceRouter.synthesize({
            text: voiceText,
            edgeConfig: ttsConfig
          });
          synthesizedVoiceByText.set(voiceText, audio);

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
      if (sendToTelegram) {
        messages.push({
          kind: "text",
          text: textPayload
        });
      }
      historyTextPieces.push(textPayload);
      visibleTextPieces.push(textPayload);
    }

    if (reminders.length > 0) {
      const summary = reminders
        .map((item) => `${item.id.slice(0, 8)} · ${new Date(item.at).toLocaleString()} · ${item.text}`)
        .join("\n");
      const reminderText = `我帮你记下这些提醒啦:\n${summary}`;
      if (sendToTelegram) {
        messages.push({
          kind: "text",
          text: reminderText
        });
      }
      historyTextPieces.push(`[提醒] ${reminders.map((item) => item.text).join("; ")}`);
      visibleTextPieces.push(reminderText);
    }

    if (historyTextPieces.length === 0) {
      const fallback = mergeVoiceIntoText(parsed);
      if (fallback) {
        if (sendToTelegram) {
          messages.push({ kind: "text", text: fallback });
        }
        historyTextPieces.push(fallback);
        if (visibleTextPieces.length === 0) {
          visibleTextPieces.push(fallback);
        }
      }
    }

    if (sendToTelegram) {
      for (const message of messages) {
        await this.telegram.send(message);
      }
    }

    if (emitPetEvents && parsed.emotions.length > 0) {
      const emotion = parsed.emotions.at(-1) ?? "idle";
      this.pet.emitEvent({
        type: "emotion",
        value: emotion
      });
    }

    if (emitPetEvents && (messages.length > 0 || destination === "pet")) {
      this.pet.emitEvent({
        type: "talking",
        value: "talking"
      });
    }

    const petSpeechText = emitPetEvents && config.realtimeVoice.enabled
      ? parsed.voiceTexts.filter((item) => item.trim().length > 0).join("\n") || parsed.visibleText
      : "";

    if (petSpeechText.trim().length > 0) {
      try {
        const cachedAudio = synthesizedVoiceByText.get(petSpeechText);
        const speechAudio =
          cachedAudio ??
          (await this.voiceRouter.synthesize({
            text: petSpeechText,
            edgeConfig: ttsConfig
          }));

        this.pet.emitEvent({
          type: "speech",
          audioBase64: speechAudio.toString("base64"),
          mimeType: "audio/mpeg"
        });
      } catch (error) {
        console.warn("Pet speech synthesis failed:", error);
      }
    }

    await this.conversation.commitAssistantMessage({
      text: historyTextPieces.join("\n"),
      activity: input.activity,
      proactive: input.proactive,
      channel: input.historyChannel ?? "telegram"
    });

    const displayText = visibleTextPieces
      .join("\n")
      .trim();

    return {
      displayText
    };
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
    this.refreshMacPerceptionPermissions();
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

    const modelDirInput = config.modelDir.trim();
    if (!modelDirInput) {
      this.pet.close();
      return;
    }

    const modelDir = path.isAbsolute(modelDirInput)
      ? modelDirInput
      : path.join(app.getAppPath(), modelDirInput);

    if (!existsSync(modelDir)) {
      this.pet.close();
      return;
    }

    this.pet.open({
      modelDir,
      alwaysOnTop: config.alwaysOnTop
    });
  }

  private async syncGlobalPetPushToTalk(): Promise<void> {
    if (!this.shouldEnableGlobalPetPushToTalk()) {
      this.globalPtt.stop();
      if (this.petPttRecording) {
        this.pet.emitEvent({
          type: "ptt",
          state: "cancel",
          reason: "桌宠语音已关闭"
        });
      }
      this.petPttRecording = false;
      return;
    }

    if (!this.ensureGlobalPttPermission()) {
      this.globalPtt.stop();
      this.petPttRecording = false;
      if (this.pet.isOnline()) {
        this.pet.emitEvent({
          type: "ptt",
          state: "cancel",
          reason: "请在系统设置中为 Yobi 打开辅助功能权限后再试。"
        });
      }
      return;
    }

    try {
      await this.globalPtt.start({
        hotkey: this.getConfig().ptt.hotkey,
        onPhase: (phase) => {
          void this.handleGlobalPetPushToTalkPhase(phase);
        }
      });
    } catch (error) {
      this.globalPtt.stop();
      this.petPttRecording = false;

      const reason = error instanceof Error ? error.message : "全局按住说话启动失败";
      if (this.pet.isOnline()) {
        this.pet.emitEvent({
          type: "ptt",
          state: "cancel",
          reason
        });
      }
    }
  }

  private shouldEnableGlobalPetPushToTalk(): boolean {
    const config = this.getConfig();
    return config.pet.enabled && config.ptt.enabled && this.pet.isOnline();
  }

  private async handleGlobalPetPushToTalkPhase(phase: GlobalPttPhase): Promise<void> {
    if (!this.shouldEnableGlobalPetPushToTalk()) {
      this.petPttRecording = false;
      return;
    }

    if (!this.ensureGlobalPttPermission()) {
      if (phase === "down") {
        this.pet.emitEvent({
          type: "ptt",
          state: "cancel",
          reason: "缺少辅助功能权限，无法监听全局快捷键。"
        });
      }
      this.petPttRecording = false;
      return;
    }

    if (!this.voiceRouter.isAlibabaSttReady()) {
      if (phase === "down") {
        this.pet.emitEvent({
          type: "ptt",
          state: "cancel",
          reason: "阿里语音识别未启用"
        });
      }
      this.petPttRecording = false;
      return;
    }

    if (phase === "down") {
      if (this.petPttRecording) {
        return;
      }

      this.petPttRecording = true;
      this.pet.emitEvent({
        type: "ptt",
        state: "start"
      });
      return;
    }

    if (!this.petPttRecording) {
      return;
    }

    this.petPttRecording = false;
    this.pet.emitEvent({
      type: "ptt",
      state: "stop"
    });
  }

  private ensureGlobalPttPermission(): boolean {
    if (process.platform !== "darwin") {
      return true;
    }

    let granted = false;
    try {
      granted = systemPreferences.isTrustedAccessibilityClient(false);
    } catch {
      granted = false;
    }

    if (!granted && !this.promptedGlobalPttPermission) {
      this.promptedGlobalPttPermission = true;
      try {
        systemPreferences.isTrustedAccessibilityClient(true);
      } catch {
        // ignore
      }

      try {
        granted = systemPreferences.isTrustedAccessibilityClient(false);
      } catch {
        granted = false;
      }
    }

    this.macAccessibilityPermission = granted ? "granted" : "denied";
    return granted;
  }

  private syncRealtimeVoice(): void {
    if (this.getConfig().realtimeVoice.enabled) {
      this.realtimeVoice.start();
      return;
    }

    this.realtimeVoice.stop();
  }

  private async collectStatus(): Promise<AppStatus> {
    this.refreshMacPerceptionPermissions();
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
      petOnline: this.pet.isOnline(),
      macAccessibilityPermission: this.macAccessibilityPermission,
      macScreenRecordingPermission: this.macScreenRecordingPermission
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

  private emitConsoleChatEvent(event: ConsoleChatEvent): void {
    if (this.consoleChatListeners.size === 0) {
      return;
    }

    for (const listener of this.consoleChatListeners) {
      listener(event);
    }
  }

  private hasPetConfigChanged(previousConfig: AppConfig, nextConfig: AppConfig): boolean {
    return (
      previousConfig.pet.enabled !== nextConfig.pet.enabled ||
      previousConfig.pet.alwaysOnTop !== nextConfig.pet.alwaysOnTop ||
      previousConfig.pet.modelDir.trim() !== nextConfig.pet.modelDir.trim()
    );
  }

  private hasGlobalPttConfigChanged(previousConfig: AppConfig, nextConfig: AppConfig): boolean {
    const previousAlibabaSttReady =
      previousConfig.alibabaVoice.enabled && previousConfig.alibabaVoice.apiKey.trim().length > 0;
    const nextAlibabaSttReady =
      nextConfig.alibabaVoice.enabled && nextConfig.alibabaVoice.apiKey.trim().length > 0;

    return (
      previousConfig.ptt.enabled !== nextConfig.ptt.enabled ||
      previousConfig.ptt.hotkey.trim() !== nextConfig.ptt.hotkey.trim() ||
      previousAlibabaSttReady !== nextAlibabaSttReady
    );
  }

  private hasRealtimeVoiceConfigChanged(previousConfig: AppConfig, nextConfig: AppConfig): boolean {
    return (
      previousConfig.realtimeVoice.enabled !== nextConfig.realtimeVoice.enabled ||
      previousConfig.realtimeVoice.whisperMode !== nextConfig.realtimeVoice.whisperMode ||
      previousConfig.realtimeVoice.autoInterrupt !== nextConfig.realtimeVoice.autoInterrupt
    );
  }

  private async refreshRuntimeAfterConfigSave(
    previousConfig: AppConfig,
    nextConfig: AppConfig
  ): Promise<void> {
    if (this.shouldRestartTelegram(previousConfig, nextConfig)) {
      await this.runConfigSideEffect("重启 Telegram", 8_000, async () => {
        await this.restartTelegram();
      });
    }

    await this.runConfigSideEffect("同步屏幕感知", 8_000, async () => {
      await this.syncPerceptionState();
    });

    await this.runConfigSideEffect("刷新运行状态", 4_000, async () => {
      await this.emitStatus();
    });
  }

  private shouldRestartTelegram(previousConfig: AppConfig, nextConfig: AppConfig): boolean {
    return (
      previousConfig.telegram.botToken !== nextConfig.telegram.botToken ||
      previousConfig.telegram.chatId !== nextConfig.telegram.chatId
    );
  }

  private async runConfigSideEffect(
    label: string,
    timeoutMs: number,
    task: () => void | Promise<void>
  ): Promise<void> {
    try {
      await this.withTimeout(Promise.resolve().then(task), timeoutMs, label);
    } catch (error) {
      console.warn(`[runtime] ${label} 失败:`, error);
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

  private refreshMacPerceptionPermissions(options?: { promptIfMissing?: boolean }): void {
    if (process.platform !== "darwin") {
      this.macAccessibilityPermission = "granted";
      this.macScreenRecordingPermission = "granted";
      return;
    }

    const promptIfMissing = Boolean(options?.promptIfMissing);
    let accessibilityGranted = false;
    try {
      accessibilityGranted = systemPreferences.isTrustedAccessibilityClient(false);
    } catch {
      accessibilityGranted = false;
    }

    if (
      !accessibilityGranted &&
      promptIfMissing &&
      !this.promptedAccessibilityPermission &&
      this.getConfig().perception.enabled
    ) {
      this.promptedAccessibilityPermission = true;
      try {
        systemPreferences.isTrustedAccessibilityClient(true);
      } catch {
        // ignore
      }

      try {
        accessibilityGranted = systemPreferences.isTrustedAccessibilityClient(false);
      } catch {
        accessibilityGranted = false;
      }
    }

    this.macAccessibilityPermission = accessibilityGranted ? "granted" : "denied";
    this.macScreenRecordingPermission = this.readMacScreenRecordingPermission();
  }

  private readMacScreenRecordingPermission(): MacPermissionState {
    if (process.platform !== "darwin") {
      return "granted";
    }

    try {
      const status = systemPreferences.getMediaAccessStatus("screen");
      if (status === "granted") {
        return "granted";
      }
      if (status === "denied" || status === "restricted") {
        return "denied";
      }
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  private normalizeModelDirectoryName(name: string): string {
    const sanitized = name
      .trim()
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 64);

    return sanitized || "live2d-model";
  }

  private async containsModel3JsonFile(baseDir: string): Promise<boolean> {
    const stack = [baseDir];

    while (stack.length > 0) {
      const currentDir = stack.pop();
      if (!currentDir) {
        continue;
      }

      let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
      try {
        entries = await readdir(currentDir, {
          withFileTypes: true
        });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }

        if (entry.isFile() && entry.name.toLowerCase().endsWith(".model3.json")) {
          return true;
        }
      }
    }

    return false;
  }
}

export const runtime = new CompanionRuntime();

app.on("before-quit", () => {
  void runtime.stop();
});
