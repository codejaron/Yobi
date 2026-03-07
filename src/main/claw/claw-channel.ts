import type {
  ClawEvent,
  ClawHistoryItem,
  ClawOrigin,
  ClawTaskSessionItem,
  ClawTaskStatus
} from "@shared/types";
import { isRecord, summarizeUnknown } from "@main/utils/guards";
import type { ClawClient } from "./claw-client";
import {
  DEFAULT_LIST_SESSION_PARAMS,
  TASK_MONITOR_MAX_AGE_MS,
  TASK_MONITOR_MAX_ITEMS,
  TASK_MONITOR_REFRESH_MS,
  type SessionListSnapshotEntry,
  type SessionMonitorState,
  defaultMonitorDisplayName,
  normalizeAgentPayload,
  extractChatErrorMessage,
  extractChatState,
  extractHistoryArray,
  extractLifecycleStatus,
  extractRunId,
  extractSessionKey,
  extractSessionListEntries,
  extractText,
  extractToolInput,
  extractToolName,
  extractToolOutput,
  isMonitoredSessionKey,
  maybeString,
  normalizeHistoryItem,
  normalizeMonitorSessionKey,
  toIsoTimestamp,
  readString,
  type SessionTerminalState
} from "./claw-channel-utils";
import type { ClawEventFrame } from "./protocol";

interface ClawChannelInput {
  defaultSessionKey?: string;
  onYobiFinal?: (input: {
    sessionKey: string;
    text: string;
    timestamp: string;
  }) => void | Promise<void>;
}

type Listener = (event: ClawEvent) => void;

export class ClawChannel {
  private readonly defaultSessionKey: string;
  private readonly listeners = new Set<Listener>();
  private readonly originQueue = new Map<string, ClawOrigin[]>();
  private readonly runOrigins = new Map<string, ClawOrigin>();
  private readonly sessionRunIds = new Map<string, string>();
  private readonly chatDeltaCache = new Map<string, string>();
  private readonly sessionMonitorMap = new Map<string, SessionMonitorState>();
  private readonly runToSessionMap = new Map<string, string>();
  private readonly unsubscribeFns: Array<() => void> = [];
  private sessionRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private sessionRefreshInFlight = false;

  constructor(
    private readonly client: ClawClient,
    private readonly input: ClawChannelInput = {}
  ) {
    this.defaultSessionKey = this.input.defaultSessionKey?.trim() || "main";

    this.unsubscribeFns.push(
      this.client.onConnection((state, message) => {
        if (state === "connected") {
          this.startSessionRefreshLoop();
          void this.refreshTaskSessions();
        } else {
          this.stopSessionRefreshLoop();
          this.clearRunningSessions();
        }

        this.emit({
          type: "connection",
          state,
          message,
          timestamp: new Date().toISOString()
        });
      })
    );

    this.unsubscribeFns.push(
      this.client.onEvent((frame) => {
        void this.handleFrame(frame);
      })
    );

    this.unsubscribeFns.push(
      this.client.onError((error) => {
        this.emit({
          type: "error",
          message: error.message || "Claw 连接异常",
          timestamp: new Date().toISOString()
        });
      })
    );
  }

  dispose(): void {
    this.stopSessionRefreshLoop();
    for (const unsubscribe of this.unsubscribeFns) {
      unsubscribe();
    }
    this.unsubscribeFns.length = 0;
    this.listeners.clear();
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getTaskMonitorEvent(): ClawEvent {
    return {
      type: "task-monitor",
      sessions: this.buildTaskMonitorSessions(),
      timestamp: new Date().toISOString()
    };
  }

  async connect(): Promise<void> {
    await this.client.connect({
      manual: true
    });
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect({
      manual: true
    });
  }

  async sendFromYobi(sessionKey: string, message: string): Promise<unknown> {
    const normalizedSession = this.normalizeSessionKey(sessionKey);
    const normalizedMessage = message.trim();
    if (!normalizedMessage) {
      throw new Error("消息不能为空");
    }

    this.clearChatDelta(normalizedSession);
    this.enqueueOrigin(normalizedSession, "yobi-tool");

    try {
      const response = await this.client.send(normalizedSession, normalizedMessage);
      const runId = extractRunId(response);
      if (runId) {
        this.sessionRunIds.set(this.toOriginSessionKey(normalizedSession), runId);
        this.runOrigins.set(runId, "yobi-tool");
        this.bindRunToSession(normalizedSession, runId);
        this.markRunStarted(normalizedSession, runId);
      }

      const timestamp = new Date().toISOString();
      this.emit({
        type: "user-message",
        sessionKey: normalizedSession,
        text: normalizedMessage,
        origin: "yobi-tool",
        timestamp
      });
      this.emit({
        type: "status",
        sessionKey: normalizedSession,
        message: "已将任务交给 Claw 执行",
        timestamp
      });
      return response;
    } catch (error) {
      this.rollbackLastOrigin(normalizedSession, "yobi-tool");
      const messageText = error instanceof Error ? error.message : summarizeUnknown(error);
      this.emit({
        type: "error",
        sessionKey: normalizedSession,
        message: messageText,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  async sendFromClaw(sessionKey: string, message: string): Promise<unknown> {
    const normalizedSession = this.normalizeSessionKey(sessionKey);
    const normalizedMessage = message.trim();
    if (!normalizedMessage) {
      throw new Error("消息不能为空");
    }

    this.clearChatDelta(normalizedSession);
    this.enqueueOrigin(normalizedSession, "claw-tab");

    try {
      const response = await this.client.send(normalizedSession, normalizedMessage);
      const runId = extractRunId(response);
      if (runId) {
        this.sessionRunIds.set(this.toOriginSessionKey(normalizedSession), runId);
        this.runOrigins.set(runId, "claw-tab");
        this.bindRunToSession(normalizedSession, runId);
        this.markRunStarted(normalizedSession, runId);
      }
      return response;
    } catch (error) {
      this.rollbackLastOrigin(normalizedSession, "claw-tab");
      const messageText = error instanceof Error ? error.message : summarizeUnknown(error);
      this.emit({
        type: "error",
        sessionKey: normalizedSession,
        message: messageText,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  async getHistory(sessionKey: string, limit = 50): Promise<ClawHistoryItem[]> {
    const normalizedSession = this.normalizeSessionKey(sessionKey);
    const raw = await this.client.getHistory(normalizedSession, limit);
    const items = extractHistoryArray(raw)
      .map((entry) => normalizeHistoryItem(entry))
      .filter((entry): entry is ClawHistoryItem => entry !== null)
      .slice(-Math.max(1, Math.min(200, limit)));

    this.emit({
      type: "history",
      sessionKey: normalizedSession,
      items,
      timestamp: new Date().toISOString()
    });

    return items;
  }

  async abort(sessionKey: string): Promise<unknown> {
    const normalizedSession = this.normalizeSessionKey(sessionKey);
    const result = await this.client.abort(normalizedSession);

    this.emit({
      type: "status",
      sessionKey: normalizedSession,
      message: "已发送中止请求",
      timestamp: new Date().toISOString()
    });

    return result;
  }

  private normalizeSessionKey(sessionKey: string): string {
    const normalized = sessionKey.trim();
    return normalized || this.defaultSessionKey;
  }

  private enqueueOrigin(sessionKey: string, origin: ClawOrigin): void {
    const originSessionKey = this.toOriginSessionKey(sessionKey);
    const queue = this.originQueue.get(originSessionKey) ?? [];
    queue.push(origin);
    this.originQueue.set(originSessionKey, queue);
  }

  private consumeOrigin(sessionKey: string, runId?: string): ClawOrigin {
    if (runId) {
      const byRunId = this.runOrigins.get(runId);
      if (byRunId) {
        this.runOrigins.delete(runId);
        return byRunId;
      }
    }

    const originSessionKey = this.toOriginSessionKey(sessionKey);
    const queue = this.originQueue.get(originSessionKey);
    if (!queue || queue.length === 0) {
      return "unknown";
    }

    const next = queue.shift() ?? "unknown";
    if (queue.length === 0) {
      this.originQueue.delete(originSessionKey);
    } else {
      this.originQueue.set(originSessionKey, queue);
    }

    return next;
  }

  private rollbackLastOrigin(sessionKey: string, origin: ClawOrigin): void {
    const originSessionKey = this.toOriginSessionKey(sessionKey);
    const queue = this.originQueue.get(originSessionKey);
    if (!queue || queue.length === 0) {
      return;
    }

    if (queue[queue.length - 1] === origin) {
      queue.pop();
    }

    if (queue.length === 0) {
      this.originQueue.delete(originSessionKey);
    } else {
      this.originQueue.set(originSessionKey, queue);
    }
  }

  private async handleFrame(frame: ClawEventFrame): Promise<void> {
    if (frame.event === "agent") {
      this.handleAgentEvent(frame.payload);
      return;
    }

    if (frame.event === "chat") {
      await this.handleChatEvent(frame.payload);
      return;
    }

    if (frame.event === "connect.challenge") {
      return;
    }

    if (frame.event === "health" || frame.event === "tick") {
      return;
    }
  }

  private handleAgentEvent(payload: unknown): void {
    const normalized = normalizeAgentPayload(payload, this.defaultSessionKey);
    const sessionKey = normalized.sessionKey;
    const runId = normalized.runId;
    const stream = normalized.stream;
    const body = normalized.body;
    const hadSessionMonitor = this.hasSessionMonitor(sessionKey);

    this.rememberRunId(sessionKey, runId || payload);
    if (runId) {
      this.bindRunToSession(sessionKey, runId);
    }

    if (isMonitoredSessionKey(this.toMonitorSessionKey(sessionKey)) && !hadSessionMonitor) {
      void this.refreshTaskSessions();
    }

    if (stream === "assistant") {
      return;
    }

    if (stream === "tool") {
      const toolName = extractToolName(body);
      const output = extractToolOutput(body);
      const input = extractToolInput(body);
      const payloadRecord = isRecord(body) ? body : null;
      const rawState = payloadRecord ? readString(payloadRecord.state).toLowerCase() : "";
      const phaseValue = payloadRecord ? readString(payloadRecord.phase).toLowerCase() : "";
      const error = payloadRecord
        ? maybeString(payloadRecord.error) ?? maybeString(payloadRecord.message)
        : undefined;
      const isToolError = payloadRecord?.isError === true;

      const phase: "start" | "result" | "error" =
        phaseValue === "error" || rawState.includes("error") || !!error || isToolError
          ? "error"
          : phaseValue === "result" || phaseValue === "end" || output !== undefined || rawState.includes("done")
            ? "result"
            : "start";

      this.emit({
        type: "tool",
        sessionKey,
        phase,
        toolName,
        input,
        output,
        error,
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (stream === "lifecycle") {
      const lifecycle = extractLifecycleStatus(body);
      const status = lifecycle.status.trim() || "update";
      const normalizedStatus = status.toLowerCase();

      if (runId) {
        if (normalizedStatus === "start") {
          this.markRunStarted(sessionKey, runId);
        } else if (normalizedStatus === "error") {
          this.markRunCompleted(sessionKey, runId, {
            terminal: "error",
            errorMessage: lifecycle.detail
          });
        } else if (
          normalizedStatus === "end" ||
          normalizedStatus === "done" ||
          normalizedStatus === "complete" ||
          normalizedStatus === "completed"
        ) {
          this.markRunCompleted(sessionKey, runId, {
            terminal: "idle"
          });
        }
      }

      if (normalizedStatus === "update" && !lifecycle.detail) {
        return;
      }
      this.emit({
        type: "lifecycle",
        sessionKey,
        status,
        detail: lifecycle.detail,
        timestamp: new Date().toISOString()
      });
    }
  }

  private async handleChatEvent(payload: unknown): Promise<void> {
    const sessionKey = extractSessionKey(payload, this.defaultSessionKey);
    const hadSessionMonitor = this.hasSessionMonitor(sessionKey);
    this.rememberRunId(sessionKey, payload);
    const state = extractChatState(payload);
    const runId = this.resolveRunId(sessionKey, payload);
    if (runId) {
      this.bindRunToSession(sessionKey, runId);
    }

    if (isMonitoredSessionKey(this.toMonitorSessionKey(sessionKey)) && !hadSessionMonitor) {
      void this.refreshTaskSessions();
    }

    if (state === "delta") {
      if (runId) {
        this.markRunStarted(sessionKey, runId);
      }

      const delta = this.resolveChatDelta(sessionKey, extractText(payload));
      if (!delta) {
        return;
      }

      this.emit({
        type: "assistant-delta",
        sessionKey,
        delta,
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (state === "final") {
      this.markRunCompleted(sessionKey, runId, {
        terminal: "idle"
      });

      const text = extractText(payload).trim();
      if (!text) {
        this.clearChatDelta(sessionKey);
        return;
      }

      const origin = this.consumeOrigin(sessionKey, runId);
      const timestamp = new Date().toISOString();

      this.emit({
        type: "assistant-final",
        sessionKey,
        text,
        origin,
        timestamp
      });

      if (origin === "yobi-tool" && this.input.onYobiFinal) {
        await this.input.onYobiFinal({
          sessionKey,
          text,
          timestamp
        });
      }
      this.clearChatDelta(sessionKey);
      return;
    }

    if (state === "error") {
      const origin = this.consumeOrigin(sessionKey, runId);
      const message = extractChatErrorMessage(payload) || "Claw 任务失败";
      const timestamp = new Date().toISOString();

      this.markRunCompleted(sessionKey, runId, {
        terminal: "error",
        errorMessage: message
      });

      this.emit({
        type: "error",
        sessionKey,
        message,
        timestamp
      });

      if (origin === "yobi-tool" && this.input.onYobiFinal) {
        await this.input.onYobiFinal({
          sessionKey,
          text: `任务失败：${message}`,
          timestamp
        });
      }
      this.clearChatDelta(sessionKey);
      return;
    }

    if (state === "aborted") {
      this.markRunCompleted(sessionKey, runId, {
        terminal: "idle"
      });
      this.clearChatDelta(sessionKey);

      this.emit({
        type: "status",
        sessionKey,
        message: "任务已中止",
        timestamp: new Date().toISOString()
      });
    }
  }

  private rememberRunId(sessionKey: string, payload: unknown): void {
    const runId = typeof payload === "string" ? payload.trim() : extractRunId(payload);
    if (!runId) {
      return;
    }

    this.sessionRunIds.set(this.toOriginSessionKey(sessionKey), runId);
    this.bindRunToSession(sessionKey, runId);
  }

  private resolveRunId(sessionKey: string, payload: unknown): string {
    const fromPayload = typeof payload === "string" ? payload.trim() : extractRunId(payload);
    if (fromPayload) {
      this.sessionRunIds.set(this.toOriginSessionKey(sessionKey), fromPayload);
      this.bindRunToSession(sessionKey, fromPayload);
      return fromPayload;
    }

    return this.sessionRunIds.get(this.toOriginSessionKey(sessionKey)) ?? "";
  }

  private toMonitorSessionKey(sessionKey: string): string {
    return normalizeMonitorSessionKey(this.normalizeSessionKey(sessionKey), this.defaultSessionKey);
  }

  private hasSessionMonitor(sessionKey: string): boolean {
    return this.sessionMonitorMap.has(this.toMonitorSessionKey(sessionKey));
  }

  private getOrCreateSessionMonitor(sessionKey: string): SessionMonitorState | null {
    const monitorKey = this.toMonitorSessionKey(sessionKey);
    if (!isMonitoredSessionKey(monitorKey)) {
      return null;
    }

    const existing = this.sessionMonitorMap.get(monitorKey);
    if (existing) {
      return existing;
    }

    const created: SessionMonitorState = {
      sessionKey: monitorKey,
      displayName: defaultMonitorDisplayName(monitorKey),
      updatedAtMs: Date.now(),
      activeRunIds: new Set<string>(),
      lastTerminal: "idle",
      lastTransitionAt: new Date().toISOString()
    };
    this.sessionMonitorMap.set(monitorKey, created);
    return created;
  }

  private resolveTaskStatus(state: SessionMonitorState): ClawTaskStatus {
    if (state.activeRunIds.size > 0) {
      return "running";
    }

    if (state.lastTerminal === "error") {
      return "error";
    }

    return "idle";
  }

  private buildTaskMonitorSessions(): ClawTaskSessionItem[] {
    const staleCutoff = Date.now() - TASK_MONITOR_MAX_AGE_MS;

    return Array.from(this.sessionMonitorMap.values())
      .filter((state) => state.activeRunIds.size > 0 || state.updatedAtMs >= staleCutoff)
      .map((state) => {
        const status = this.resolveTaskStatus(state);
        return {
          sessionKey: state.sessionKey,
          displayName: state.displayName || defaultMonitorDisplayName(state.sessionKey),
          status,
          activeRunCount: state.activeRunIds.size,
          updatedAt: toIsoTimestamp(state.updatedAtMs),
          lastError: status === "error" ? state.lastError : undefined,
          lastTransitionAt: state.lastTransitionAt
        } satisfies ClawTaskSessionItem;
      })
      .sort((a, b) => {
        const aPriority = a.status === "running" ? 0 : 1;
        const bPriority = b.status === "running" ? 0 : 1;
        if (aPriority !== bPriority) {
          return aPriority - bPriority;
        }

        const aUpdatedAt = Date.parse(a.updatedAt);
        const bUpdatedAt = Date.parse(b.updatedAt);
        if (Number.isFinite(aUpdatedAt) && Number.isFinite(bUpdatedAt) && bUpdatedAt !== aUpdatedAt) {
          return bUpdatedAt - aUpdatedAt;
        }

        return a.sessionKey.localeCompare(b.sessionKey);
      })
      .slice(0, TASK_MONITOR_MAX_ITEMS);
  }

  private emitTaskMonitorSnapshot(): void {
    this.emit({
      type: "task-monitor",
      sessions: this.buildTaskMonitorSessions(),
      timestamp: new Date().toISOString()
    });
  }

  private bindRunToSession(sessionKey: string, runId: string): void {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) {
      return;
    }

    const state = this.getOrCreateSessionMonitor(sessionKey);
    if (!state) {
      return;
    }

    const previousSessionKey = this.runToSessionMap.get(normalizedRunId);
    if (previousSessionKey && previousSessionKey !== state.sessionKey) {
      const previous = this.sessionMonitorMap.get(previousSessionKey);
      previous?.activeRunIds.delete(normalizedRunId);
    }

    this.runToSessionMap.set(normalizedRunId, state.sessionKey);
  }

  private markRunStarted(sessionKey: string, runId: string): void {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) {
      return;
    }

    const state = this.getOrCreateSessionMonitor(sessionKey);
    if (!state) {
      return;
    }

    const previousCount = state.activeRunIds.size;
    const previousStatus = this.resolveTaskStatus(state);

    this.runToSessionMap.set(normalizedRunId, state.sessionKey);
    state.activeRunIds.add(normalizedRunId);
    state.updatedAtMs = Math.max(state.updatedAtMs, Date.now());

    const nextStatus = this.resolveTaskStatus(state);
    if (previousStatus !== nextStatus) {
      state.lastTransitionAt = new Date().toISOString();
    }

    if (previousCount !== state.activeRunIds.size || previousStatus !== nextStatus) {
      this.emitTaskMonitorSnapshot();
    }
  }

  private markRunCompleted(
    sessionKey: string,
    runId: string,
    input: {
      terminal: SessionTerminalState;
      errorMessage?: string;
    }
  ): void {
    const normalizedRunId = runId.trim();
    const sessionByRun = normalizedRunId ? this.runToSessionMap.get(normalizedRunId) : undefined;
    const state =
      (sessionByRun ? this.sessionMonitorMap.get(sessionByRun) : null) ??
      this.getOrCreateSessionMonitor(sessionKey);
    if (!state) {
      return;
    }

    const previousCount = state.activeRunIds.size;
    const previousStatus = this.resolveTaskStatus(state);

    if (normalizedRunId) {
      state.activeRunIds.delete(normalizedRunId);
      this.runToSessionMap.delete(normalizedRunId);
    }

    if (state.activeRunIds.size === 0) {
      state.lastTerminal = input.terminal;
      if (input.terminal === "error") {
        const errorMessage = input.errorMessage?.trim();
        if (errorMessage) {
          state.lastError = errorMessage;
        }
      } else {
        state.lastError = undefined;
      }
    }

    state.updatedAtMs = Math.max(state.updatedAtMs, Date.now());
    const nextStatus = this.resolveTaskStatus(state);
    if (previousStatus !== nextStatus) {
      state.lastTransitionAt = new Date().toISOString();
    }

    if (
      previousCount !== state.activeRunIds.size ||
      previousStatus !== nextStatus ||
      (input.terminal === "error" && state.activeRunIds.size === 0)
    ) {
      this.emitTaskMonitorSnapshot();
    }
  }

  private clearRunningSessions(): void {
    let changed = false;
    for (const state of this.sessionMonitorMap.values()) {
      if (state.activeRunIds.size === 0) {
        continue;
      }

      const previousStatus = this.resolveTaskStatus(state);
      state.activeRunIds.clear();
      if (state.lastTerminal !== "error") {
        state.lastTerminal = "idle";
      }
      state.updatedAtMs = Math.max(state.updatedAtMs, Date.now());
      const nextStatus = this.resolveTaskStatus(state);
      if (previousStatus !== nextStatus) {
        state.lastTransitionAt = new Date().toISOString();
      }
      changed = true;
    }

    if (this.runToSessionMap.size > 0) {
      this.runToSessionMap.clear();
      changed = true;
    }

    if (changed) {
      this.emitTaskMonitorSnapshot();
    }
  }

  private startSessionRefreshLoop(): void {
    if (this.sessionRefreshTimer) {
      return;
    }

    this.sessionRefreshTimer = setInterval(() => {
      void this.refreshTaskSessions();
    }, TASK_MONITOR_REFRESH_MS);
  }

  private stopSessionRefreshLoop(): void {
    if (!this.sessionRefreshTimer) {
      return;
    }

    clearInterval(this.sessionRefreshTimer);
    this.sessionRefreshTimer = null;
  }

  private async refreshTaskSessions(): Promise<void> {
    if (this.sessionRefreshInFlight) {
      return;
    }

    this.sessionRefreshInFlight = true;
    try {
      const result = await this.client.listSessions(DEFAULT_LIST_SESSION_PARAMS);
      this.applySessionSnapshots(extractSessionListEntries(result, this.defaultSessionKey));
    } catch {
      // ignore gateway list errors
    } finally {
      this.sessionRefreshInFlight = false;
    }
  }

  private applySessionSnapshots(entries: SessionListSnapshotEntry[]): void {
    const keepKeys = new Set<string>();
    let changed = false;

    for (const entry of entries) {
      keepKeys.add(entry.sessionKey);

      const existing = this.sessionMonitorMap.get(entry.sessionKey);
      if (!existing) {
        this.sessionMonitorMap.set(entry.sessionKey, {
          sessionKey: entry.sessionKey,
          displayName: entry.displayName || defaultMonitorDisplayName(entry.sessionKey),
          updatedAtMs: entry.updatedAtMs,
          activeRunIds: new Set<string>(),
          lastTerminal: "idle",
          lastTransitionAt: new Date().toISOString()
        });
        changed = true;
        continue;
      }

      if (entry.displayName && existing.displayName !== entry.displayName) {
        existing.displayName = entry.displayName;
        changed = true;
      }

      if (entry.updatedAtMs > existing.updatedAtMs) {
        existing.updatedAtMs = entry.updatedAtMs;
        changed = true;
      }
    }

    for (const [sessionKey, state] of this.sessionMonitorMap.entries()) {
      if (keepKeys.has(sessionKey) || state.activeRunIds.size > 0) {
        continue;
      }

      this.sessionMonitorMap.delete(sessionKey);
      changed = true;
    }

    if (changed) {
      this.emitTaskMonitorSnapshot();
    }
  }

  private toOriginSessionKey(sessionKey: string): string {
    const normalized = this.normalizeSessionKey(sessionKey);
    const mainAlias = `agent:main:${this.defaultSessionKey}`;
    if (normalized === mainAlias) {
      return this.defaultSessionKey;
    }

    return normalized;
  }

  private resolveChatDelta(sessionKey: string, raw: string): string {
    const incoming = raw;
    if (!incoming) {
      return "";
    }

    const key = this.toOriginSessionKey(sessionKey);
    const previous = this.chatDeltaCache.get(key) ?? "";
    if (!previous) {
      this.chatDeltaCache.set(key, incoming);
      return incoming;
    }

    if (incoming === previous) {
      return "";
    }

    if (incoming.startsWith(previous)) {
      const delta = incoming.slice(previous.length);
      this.chatDeltaCache.set(key, incoming);
      return delta;
    }

    if (previous.startsWith(incoming)) {
      return "";
    }

    let overlap = 0;
    const max = Math.min(previous.length, incoming.length);
    for (let size = max; size > 0; size -= 1) {
      if (previous.slice(-size) === incoming.slice(0, size)) {
        overlap = size;
        break;
      }
    }

    const delta = overlap > 0 ? incoming.slice(overlap) : incoming;
    this.chatDeltaCache.set(key, `${previous}${delta}`);
    return delta;
  }

  private clearChatDelta(sessionKey: string): void {
    this.chatDeltaCache.delete(this.toOriginSessionKey(sessionKey));
  }

  private emit(event: ClawEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
