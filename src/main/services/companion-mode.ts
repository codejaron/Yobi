import { generateText } from "ai";
import { z } from "zod";
import type {
  AppConfig,
  ChatAttachment,
  CompanionModeEvent,
  CompanionModeFrontWindow,
  CompanionModeState,
  HistoryMessage,
  RealtimeVoiceMode,
  SystemPermissionStatus,
  VoiceSessionState
} from "@shared/types";
import type { ModelFactory } from "@main/core/model-factory";
import { resolveOpenAIStoreOption } from "@main/core/provider-utils";
import { isWithinQuietHours } from "@main/kernel/relationship-utils";
import type { FrontWindowCaptureFrame } from "./front-window-capture";
import type { AppLogger } from "./logger";

const COMPANION_SAMPLE_INTERVAL_MS = 25_000;
const PROACTIVE_COOLDOWN_MS = 5 * 60_000;
const LOCAL_PREFILTER_THRESHOLD = 0.015;
const SPEECH_RECAPTURE_DIFF_THRESHOLD = 0.04;
const SPEECH_RECAPTURE_MIN_MS = 8_000;
const TITLE_STABLE_MS = 1_500;
const TITLE_TRIGGER_COOLDOWN_MS = 10_000;

const proactiveDecisionSchema = z.object({
  decision: z.enum(["skip", "speak"]),
  reason: z.string().min(1),
  message: z.string().nullable()
}).strict();

export interface CompanionSpeechCaptureSession {
  attachments: ChatAttachment[];
  startedAtMs: number;
  lastBitmap: Buffer;
  frontWindow: CompanionModeFrontWindow;
  recaptureUsed: boolean;
  pendingTitleChange: {
    title: string;
    firstSeenAtMs: number;
  } | null;
  lastTitleTriggerAtMs: number;
  nextCheckAtMs: number;
}

export interface CompanionModeServiceInput {
  logger: AppLogger;
  getConfig: () => AppConfig;
  getSystemPermissions: () => SystemPermissionStatus;
  getVoiceSessionState: () => VoiceSessionState;
  startVoiceSession: (input?: { mode?: RealtimeVoiceMode }) => Promise<VoiceSessionState>;
  stopVoiceSession: () => Promise<{ accepted: boolean }>;
  dispatchAutomationMessage: (input: {
    text: string;
    frontWindow?: CompanionModeFrontWindow | null;
    attachments?: ChatAttachment[];
  }) => Promise<boolean>;
  readActivitySnapshot: () => {
    lastUserAt: string | null;
    lastProactiveAt: string | null;
    lastInboundChannel: string | null;
    lastInboundChatId: string | null;
    lastTelegramChatId: string | null;
    lastFeishuChatId: string | null;
    lastQQChatId: string | null;
  };
  getRecentHistory: () => Promise<HistoryMessage[]>;
  captureFrontWindow: () => Promise<FrontWindowCaptureFrame | null>;
  modelFactory?: ModelFactory;
  onStatusChange?: () => void | Promise<void>;
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

function nowIso(now = Date.now()): string {
  return new Date(now).toISOString();
}

function createState(input?: Partial<CompanionModeState>): CompanionModeState {
  return {
    active: false,
    availability: "ready",
    reason: null,
    lastSampleAt: null,
    lastProactiveAt: null,
    frontWindow: null,
    ...input
  };
}

export function computeCompanionFrameDiffRatio(left: Buffer, right: Buffer): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 1;
  }

  let totalDelta = 0;
  let totalChannels = 0;
  for (let index = 0; index < left.length; index += 4) {
    totalDelta += Math.abs((left[index] ?? 0) - (right[index] ?? 0));
    totalDelta += Math.abs((left[index + 1] ?? 0) - (right[index + 1] ?? 0));
    totalDelta += Math.abs((left[index + 2] ?? 0) - (right[index + 2] ?? 0));
    totalChannels += 3;
  }

  if (totalChannels === 0) {
    return 1;
  }

  return totalDelta / (totalChannels * 255);
}

export class CompanionModeService {
  private readonly listeners = new Set<(event: CompanionModeEvent) => void>();
  private state = createState();
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private autoStartedVoiceSession = false;
  private lastIdleFrame: {
    bitmap: Buffer;
    frontWindow: CompanionModeFrontWindow;
    capturedAtMs: number;
  } | null = null;
  private pendingIdleTitleChange: {
    title: string;
    firstSeenAtMs: number;
  } | null = null;
  private lastIdleTitleTriggerAtMs = 0;

  constructor(private readonly input: CompanionModeServiceInput) {}

  getState(): CompanionModeState {
    const activity = this.input.readActivitySnapshot();
    return {
      ...this.state,
      lastProactiveAt: activity.lastProactiveAt
    };
  }

  isActive(): boolean {
    return this.state.active;
  }

  onEvent(listener: (event: CompanionModeEvent) => void): () => void {
    this.listeners.add(listener);
    listener({
      type: "state",
      state: this.getState(),
      timestamp: nowIso(this.getNow())
    });
    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(): Promise<CompanionModeState> {
    const permissions = this.input.getSystemPermissions();
    if (permissions.microphone !== "granted") {
      this.state = createState({
        active: false,
        availability: "microphone-permission-required",
        reason: "缺少麦克风权限，无法开启陪伴模式。"
      });
      this.emitState();
      await this.notifyStatusChange();
      return this.getState();
    }

    if (permissions.screenCapture !== "granted") {
      this.state = createState({
        active: false,
        availability: "screen-permission-required",
        reason: "缺少屏幕录制权限，无法开启陪伴模式。"
      });
      this.emitState();
      await this.notifyStatusChange();
      return this.getState();
    }

    const previousVoiceState = this.input.getVoiceSessionState();
    this.autoStartedVoiceSession = previousVoiceState.sessionId === null;
    await this.input.startVoiceSession({
      mode: "free"
    });

    this.state = createState({
      active: true,
      availability: "ready",
      reason: null
    });
    this.ensureSampleTimer();
    this.emitState();
    await this.notifyStatusChange();
    return this.getState();
  }

  async stop(): Promise<CompanionModeState> {
    if (this.sampleTimer) {
      (this.input.clearIntervalFn ?? clearInterval)(this.sampleTimer);
      this.sampleTimer = null;
    }

    if (this.autoStartedVoiceSession) {
      await this.input.stopVoiceSession().catch(() => ({ accepted: false }));
    }
    this.autoStartedVoiceSession = false;
    this.lastIdleFrame = null;
    this.pendingIdleTitleChange = null;
    this.lastIdleTitleTriggerAtMs = 0;

    this.state = createState({
      active: false,
      availability: "ready",
      reason: null,
      frontWindow: this.state.frontWindow,
      lastSampleAt: this.state.lastSampleAt
    });
    this.emitState();
    await this.notifyStatusChange();
    return this.getState();
  }

  private ensureSampleTimer(): void {
    if (this.sampleTimer) {
      return;
    }

    const setIntervalFn = this.input.setIntervalFn ?? setInterval;
    this.sampleTimer = setIntervalFn(() => {
      void this.sampleIfIdle();
    }, COMPANION_SAMPLE_INTERVAL_MS);
    this.sampleTimer.unref?.();
  }

  private async sampleIfIdle(): Promise<void> {
    if (!this.state.active) {
      return;
    }

    const permissions = this.input.getSystemPermissions();
    if (permissions.screenCapture !== "granted") {
      this.state = {
        ...this.state,
        availability: "screen-permission-required",
        reason: "屏幕录制权限已失效，陪伴模式已暂停视觉感知。"
      };
      this.emitState();
      await this.notifyStatusChange();
      return;
    }

    const voiceState = this.input.getVoiceSessionState();
    if (voiceState.phase === "user-speaking" || voiceState.phase === "transcribing") {
      return;
    }
    if (voiceState.playback.active) {
      return;
    }

    const config = this.input.getConfig();
    if (isWithinQuietHours(new Date(this.getNow()), config.proactive.quietHours)) {
      return;
    }

    const activity = this.input.readActivitySnapshot();
    if (activity.lastProactiveAt) {
      const lastProactiveAtMs = Date.parse(activity.lastProactiveAt);
      if (Number.isFinite(lastProactiveAtMs) && this.getNow() - lastProactiveAtMs < PROACTIVE_COOLDOWN_MS) {
        return;
      }
    }

    const frame = await this.input.captureFrontWindow().catch((error) => {
      this.input.logger.warn("companion-mode", "capture-front-window-failed", undefined, error);
      return null;
    });
    if (!frame) {
      return;
    }

    const capturedAtMs = this.getNow();
    this.state = {
      ...this.state,
      availability: "ready",
      reason: null,
      lastSampleAt: nowIso(capturedAtMs),
      frontWindow: frame.frontWindow
    };

    if (!this.lastIdleFrame) {
      this.lastIdleFrame = {
        bitmap: frame.diffBitmap,
        frontWindow: frame.frontWindow,
        capturedAtMs
      };
      this.emit({
        type: "proactive-check",
        outcome: "baseline",
        frontWindow: frame.frontWindow,
        timestamp: nowIso(capturedAtMs)
      });
      this.emitState();
      await this.notifyStatusChange();
      return;
    }

    const sameApp =
      normalizeWindowToken(this.lastIdleFrame.frontWindow.appName) === normalizeWindowToken(frame.frontWindow.appName);
    const diffRatio = sameApp ? computeCompanionFrameDiffRatio(this.lastIdleFrame.bitmap, frame.diffBitmap) : 1;
    const titleTriggered = this.observeIdleTitleChange(frame.frontWindow.title, capturedAtMs);
    if (sameApp && diffRatio < LOCAL_PREFILTER_THRESHOLD && !titleTriggered) {
      this.lastIdleFrame = {
        bitmap: frame.diffBitmap,
        frontWindow: frame.frontWindow,
        capturedAtMs
      };
      this.emit({
        type: "proactive-check",
        outcome: "skip-prefilter",
        diffRatio,
        frontWindow: frame.frontWindow,
        timestamp: nowIso(capturedAtMs)
      });
      this.emitState();
      await this.notifyStatusChange();
      return;
    }

    if (!titleTriggered && normalizeWindowToken(this.lastIdleFrame.frontWindow.title) !== normalizeWindowToken(frame.frontWindow.title)) {
      this.lastIdleFrame = {
        bitmap: frame.diffBitmap,
        frontWindow: frame.frontWindow,
        capturedAtMs
      };
      this.emit({
        type: "proactive-check",
        outcome: "skip-title-unstable",
        diffRatio,
        frontWindow: frame.frontWindow,
        timestamp: nowIso(capturedAtMs)
      });
      this.emitState();
      await this.notifyStatusChange();
      return;
    }

    const decision = await this.evaluateProactiveFrame(frame, diffRatio);
    this.lastIdleFrame = {
      bitmap: frame.diffBitmap,
      frontWindow: frame.frontWindow,
      capturedAtMs
    };
    if (!decision || decision.decision === "skip" || !decision.message?.trim()) {
      this.emit({
        type: "proactive-check",
        outcome: "skip-llm",
        diffRatio,
        frontWindow: frame.frontWindow,
        timestamp: nowIso(capturedAtMs)
      });
      this.emitState();
      await this.notifyStatusChange();
      return;
    }

    const attachment = await frame.storeAttachment().catch((error) => {
      this.input.logger.warn("companion-mode", "store-proactive-capture-failed", undefined, error);
      return null;
    });
    const delivered = await this.input.dispatchAutomationMessage({
      text: decision.message.trim(),
      frontWindow: frame.frontWindow,
      attachments: attachment ? [attachment] : undefined
    });
    if (delivered) {
      this.emit({
        type: "proactive-check",
        outcome: "speak",
        diffRatio,
        frontWindow: frame.frontWindow,
        timestamp: nowIso(capturedAtMs)
      });
      this.emit({
        type: "proactive-fired",
        text: decision.message.trim(),
        frontWindow: frame.frontWindow,
        timestamp: nowIso(capturedAtMs)
      });
    }
    this.emitState();
    await this.notifyStatusChange();
  }

  async captureSpeechStartContext(): Promise<CompanionSpeechCaptureSession | null> {
    if (!this.state.active) {
      return null;
    }

    if (this.input.getSystemPermissions().screenCapture !== "granted") {
      return null;
    }

    const frame = await this.input.captureFrontWindow().catch((error) => {
      this.input.logger.warn("companion-mode", "capture-speech-start-failed", undefined, error);
      return null;
    });
    if (!frame) {
      return null;
    }

    const attachment = await frame.storeAttachment().catch((error) => {
      this.input.logger.warn("companion-mode", "store-speech-start-capture-failed", undefined, error);
      return null;
    });
    const session: CompanionSpeechCaptureSession = {
      attachments: attachment ? [attachment] : [],
      startedAtMs: this.getNow(),
      lastBitmap: frame.diffBitmap,
      frontWindow: frame.frontWindow,
      recaptureUsed: false,
      pendingTitleChange: null,
      lastTitleTriggerAtMs: 0,
      nextCheckAtMs: this.getNow() + TITLE_STABLE_MS
    };
    this.emit({
      type: "speech-capture",
      stage: "start",
      attached: attachment !== null,
      frontWindow: frame.frontWindow,
      timestamp: nowIso(this.getNow())
    });
    return session;
  }

  async maybeCaptureSpeechRecapture(session: CompanionSpeechCaptureSession | null): Promise<void> {
    if (!session || !this.state.active || session.recaptureUsed) {
      return;
    }

    const nowMs = this.getNow();
    if (nowMs - session.startedAtMs < SPEECH_RECAPTURE_MIN_MS || nowMs < session.nextCheckAtMs) {
      return;
    }

    if (this.input.getSystemPermissions().screenCapture !== "granted") {
      return;
    }

    session.nextCheckAtMs = nowMs + TITLE_STABLE_MS;
    const frame = await this.input.captureFrontWindow().catch((error) => {
      this.input.logger.warn("companion-mode", "capture-speech-recapture-failed", undefined, error);
      return null;
    });
    if (!frame) {
      return;
    }

    const diffRatio = computeCompanionFrameDiffRatio(session.lastBitmap, frame.diffBitmap);
    const titleTriggered = this.observeSpeechTitleChange(session, frame.frontWindow.title, nowMs);
    if (diffRatio < SPEECH_RECAPTURE_DIFF_THRESHOLD && !titleTriggered) {
      return;
    }

    const attachment = await frame.storeAttachment().catch((error) => {
      this.input.logger.warn("companion-mode", "store-speech-recapture-failed", undefined, error);
      return null;
    });
    if (!attachment) {
      return;
    }

    session.attachments.push(attachment);
    session.lastBitmap = frame.diffBitmap;
    session.frontWindow = frame.frontWindow;
    session.recaptureUsed = true;
    this.emit({
      type: "speech-capture",
      stage: "recapture",
      attached: true,
      frontWindow: frame.frontWindow,
      timestamp: nowIso(nowMs)
    });
  }

  private emitState(): void {
    this.emit({
      type: "state",
      state: this.getState(),
      timestamp: nowIso(this.getNow())
    });
  }

  private emit(event: CompanionModeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.input.logger.warn("companion-mode", "listener-failed", undefined, error);
      }
    }
  }

  private async notifyStatusChange(): Promise<void> {
    await this.input.onStatusChange?.();
  }

  private getNow(): number {
    return this.input.now?.() ?? Date.now();
  }

  private observeIdleTitleChange(nextTitle: string, nowMs: number): boolean {
    const previousTitle = this.lastIdleFrame?.frontWindow.title ?? "";
    return observeStableTitleChange({
      previousTitle,
      nextTitle,
      nowMs,
      pending: this.pendingIdleTitleChange,
      lastTriggeredAtMs: this.lastIdleTitleTriggerAtMs
    }, (nextPending, triggeredAtMs) => {
      this.pendingIdleTitleChange = nextPending;
      this.lastIdleTitleTriggerAtMs = triggeredAtMs;
    });
  }

  private observeSpeechTitleChange(
    session: CompanionSpeechCaptureSession,
    nextTitle: string,
    nowMs: number
  ): boolean {
    return observeStableTitleChange({
      previousTitle: session.frontWindow.title,
      nextTitle,
      nowMs,
      pending: session.pendingTitleChange,
      lastTriggeredAtMs: session.lastTitleTriggerAtMs
    }, (nextPending, triggeredAtMs) => {
      session.pendingTitleChange = nextPending;
      session.lastTitleTriggerAtMs = triggeredAtMs;
    });
  }

  private async evaluateProactiveFrame(
    frame: FrontWindowCaptureFrame,
    diffRatio: number
  ): Promise<z.infer<typeof proactiveDecisionSchema> | null> {
    if (!this.input.modelFactory) {
      return null;
    }

    const recentDialogue = await this.input.getRecentHistory().catch(() => []);
    const prompt = [
      "你是桌面 AI 陪伴体，正在判断是否应该基于用户当前前台窗口主动说一句。",
      "如果当前画面没有明显值得开口的切入点，或者说话会显得打扰，就选择 skip。",
      "只有在自然、不突兀、对用户当下内容有明显贴合点时才选择 speak。",
      `前台应用：${frame.frontWindow.appName || "unknown"}`,
      `窗口标题：${frame.frontWindow.title || "unknown"}`,
      `最近画面变化强度：${diffRatio.toFixed(4)}`,
      `当前本地时间：${new Date(this.getNow()).toISOString()}`,
      "",
      "最近对话：",
      formatRecentDialogue(recentDialogue),
      "",
      '返回严格 JSON：{"decision":"skip|speak","reason":"...","message":"...或 null"}'
    ].join("\n");

    try {
      const result = await generateText({
        model: this.input.modelFactory.getCognitionModel(),
        providerOptions: resolveOpenAIStoreOption(this.input.getConfig(), "cognition"),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: prompt
              },
              {
                type: "image",
                image: frame.modelImage.buffer,
                mediaType: frame.modelImage.mimeType
              }
            ]
          }
        ],
        maxOutputTokens: 220
      });
      const parsed = proactiveDecisionSchema.parse(extractStructuredJson(result.text));
      return parsed;
    } catch (error) {
      this.input.logger.warn("companion-mode", "proactive-evaluation-failed", undefined, error);
      return null;
    }
  }
}

export const COMPANION_MODE_DEFAULTS = {
  sampleIntervalMs: COMPANION_SAMPLE_INTERVAL_MS,
  proactiveCooldownMs: PROACTIVE_COOLDOWN_MS,
  localPrefilterThreshold: LOCAL_PREFILTER_THRESHOLD
} as const;

function normalizeWindowToken(value: string): string {
  return value.trim().toLowerCase();
}

function formatRecentDialogue(messages: HistoryMessage[]): string {
  if (messages.length === 0) {
    return "(none)";
  }

  return messages
    .slice(-6)
    .map((message) => `${message.role}: ${message.text}`)
    .join("\n");
}

function extractStructuredJson(text: string): unknown {
  const trimmed = text.trim();
  const candidate = trimmed.replace(/^```json\s*|\s*```$/g, "");
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("model response did not contain JSON");
  }

  return JSON.parse(candidate.slice(start, end + 1));
}

function observeStableTitleChange(
  input: {
    previousTitle: string;
    nextTitle: string;
    nowMs: number;
    pending: {
      title: string;
      firstSeenAtMs: number;
    } | null;
    lastTriggeredAtMs: number;
  },
  assign: (
    pending: {
      title: string;
      firstSeenAtMs: number;
    } | null,
    lastTriggeredAtMs: number
  ) => void
): boolean {
  const previousTitle = normalizeWindowToken(input.previousTitle);
  const nextTitle = normalizeWindowToken(input.nextTitle);
  if (!nextTitle || nextTitle === previousTitle) {
    assign(null, input.lastTriggeredAtMs);
    return false;
  }

  if (!input.pending || normalizeWindowToken(input.pending.title) !== nextTitle) {
    assign({
      title: input.nextTitle,
      firstSeenAtMs: input.nowMs
    }, input.lastTriggeredAtMs);
    return false;
  }

  if (input.nowMs - input.pending.firstSeenAtMs < TITLE_STABLE_MS) {
    assign(input.pending, input.lastTriggeredAtMs);
    return false;
  }

  if (input.nowMs - input.lastTriggeredAtMs < TITLE_TRIGGER_COOLDOWN_MS) {
    assign(input.pending, input.lastTriggeredAtMs);
    return false;
  }

  assign(null, input.nowMs);
  return true;
}
