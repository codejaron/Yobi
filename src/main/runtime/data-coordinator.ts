import {
  DEFAULT_KERNEL_STATE,
  DEFAULT_RELATIONSHIP_GUIDE,
  type AppStatus,
  type HistoryMessage,
  type KernelStateDocument,
  type MindSnapshot,
  type RelationshipGuide,
  type UserProfile
} from "@shared/types";
import { readTextFile, writeTextFileAtomic } from "@main/storage/fs";
import { DEFAULT_SOUL_TEXT } from "@main/kernel/init";
import type { CompanionPaths } from "@main/storage/paths";
import type { YobiMemory } from "@main/memory/setup";
import type { StateStore } from "@main/kernel/state-store";
import type { KernelEngine } from "@main/kernel/engine";
import type { BilibiliBrowseService } from "@main/services/browse/bilibili-browse-service";
import type { BilibiliSyncCoordinator } from "@main/services/browse/bilibili-sync-coordinator";
import type { SystemPermissionsService } from "@main/services/system-permissions";
import {
  ensureRelationshipGuideFile,
  loadRelationshipGuide,
  saveRelationshipGuide
} from "@main/relationship/guide-store";

interface HistoryQuery {
  query?: string;
  limit?: number;
  offset?: number;
}

interface RuntimeDataCoordinatorInput {
  paths: CompanionPaths;
  memory: YobiMemory;
  stateStore: StateStore;
  kernel: KernelEngine;
  bilibiliBrowse: BilibiliBrowseService;
  bilibiliSyncCoordinator: BilibiliSyncCoordinator;
  systemPermissionsService: SystemPermissionsService;
  resourceId: string;
  threadId: string;
  emitStatus: () => Promise<void>;
}

export class RuntimeDataCoordinator {
  constructor(private readonly input: RuntimeDataCoordinatorInput) {}

  async getHistory(options: HistoryQuery): Promise<HistoryMessage[]> {
    return this.input.memory.listHistory({
      resourceId: this.input.resourceId,
      threadId: this.input.threadId,
      query: options.query,
      limit: options.limit,
      offset: options.offset
    });
  }

  async clearHistory(): Promise<void> {
    await this.input.memory.clearThread({
      resourceId: this.input.resourceId,
      threadId: this.input.threadId
    });
    await this.input.emitStatus();
  }

  async getMindSnapshot(): Promise<MindSnapshot> {
    const [soul, relationship, profile, facts, episodes] = await Promise.allSettled([
      readTextFile(this.input.paths.soulPath, ""),
      loadRelationshipGuide(this.input.paths),
      this.input.memory.getProfile(),
      this.input.memory.listFacts(),
      this.input.memory.listRecentEpisodes(20)
    ]);

    return {
      soul: soul.status === "fulfilled" ? soul.value : "",
      relationship: relationship.status === "fulfilled" ? relationship.value : await ensureRelationshipGuideFile(this.input.paths),
      state: this.input.stateStore.getSnapshot(),
      profile:
        profile.status === "fulfilled"
          ? profile.value
          : this.input.memory.getProfileStore().getProfile(),
      recentFacts: facts.status === "fulfilled" ? facts.value.slice(-50) : [],
      recentEpisodes: episodes.status === "fulfilled" ? episodes.value.slice(0, 20) : []
    };
  }

  async getSoul(): Promise<{ markdown: string; updatedAt: string }> {
    return {
      markdown: await readTextFile(this.input.paths.soulPath, ""),
      updatedAt: new Date().toISOString()
    };
  }

  async saveSoul(input: { markdown: string }): Promise<{ markdown: string; updatedAt: string }> {
    const markdown = input.markdown.trim();
    await writeTextFileAtomic(this.input.paths.soulPath, `${markdown}\n`);
    return {
      markdown,
      updatedAt: new Date().toISOString()
    };
  }

  async getRelationship(): Promise<{ guide: RelationshipGuide; updatedAt: string }> {
    return {
      guide: await loadRelationshipGuide(this.input.paths),
      updatedAt: new Date().toISOString()
    };
  }

  async saveRelationship(input: { guide: RelationshipGuide }): Promise<{ guide: RelationshipGuide; updatedAt: string }> {
    const guide = await saveRelationshipGuide(this.input.paths, input.guide);
    return {
      guide,
      updatedAt: new Date().toISOString()
    };
  }

  async patchState(input: { patch: Partial<KernelStateDocument> }): Promise<KernelStateDocument> {
    const next = this.input.stateStore.mutate((state) => {
      const patch = input.patch;
      if (!patch || typeof patch !== "object") {
        return;
      }
      if (patch.emotional) {
        state.emotional = { ...state.emotional, ...patch.emotional };
      }
      if (patch.relationship) {
        state.relationship = { ...state.relationship, ...patch.relationship };
      }
      if (typeof patch.coldStart === "boolean") {
        state.coldStart = patch.coldStart;
      }
      if (patch.sessionReentry !== undefined) {
        state.sessionReentry = patch.sessionReentry
          ? { ...state.sessionReentry, ...patch.sessionReentry }
          : null;
      }
    });
    await this.input.stateStore.flushIfDirty();
    return next;
  }

  async patchProfile(input: { patch: Partial<UserProfile> }): Promise<UserProfile> {
    return this.input.memory.getProfileStore().applySemanticPatch((draft) => {
      const patch = input.patch;
      if (!patch || typeof patch !== "object") {
        return;
      }
      if (patch.identity) {
        draft.identity = { ...draft.identity, ...patch.identity };
      }
      if (patch.communication) {
        draft.communication = { ...draft.communication, ...patch.communication };
      }
      if (patch.patterns) {
        draft.patterns = { ...draft.patterns, ...patch.patterns };
      }
      if (patch.interaction_notes) {
        draft.interaction_notes = {
          ...draft.interaction_notes,
          ...patch.interaction_notes,
          trust_areas: {
            ...draft.interaction_notes.trust_areas,
            ...(patch.interaction_notes.trust_areas ?? {})
          }
        };
      }
    });
  }

  async resetMindSection(input: {
    section: "soul" | "relationship" | "state" | "profile" | "facts" | "episodes";
  }): Promise<{ accepted: boolean; message: string }> {
    const section = input.section;
    if (section === "soul") {
      await writeTextFileAtomic(this.input.paths.soulPath, `${DEFAULT_SOUL_TEXT.trim()}\n`);
      return { accepted: true, message: "SOUL 已恢复默认。" };
    }
    if (section === "relationship") {
      await saveRelationshipGuide(this.input.paths, DEFAULT_RELATIONSHIP_GUIDE);
      return { accepted: true, message: "RELATIONSHIP 已恢复默认。" };
    }
    if (section === "state") {
      this.input.stateStore.mutate((state) => {
        state.emotional = { ...DEFAULT_KERNEL_STATE.emotional };
        state.relationship = { ...DEFAULT_KERNEL_STATE.relationship };
        state.coldStart = DEFAULT_KERNEL_STATE.coldStart;
        state.sessionReentry = DEFAULT_KERNEL_STATE.sessionReentry
          ? { ...DEFAULT_KERNEL_STATE.sessionReentry }
          : null;
      });
      await this.input.stateStore.flushIfDirty();
      return { accepted: true, message: "STATE 已恢复默认。" };
    }
    if (section === "profile") {
      await this.input.memory.getProfileStore().resetToDefault();
      return { accepted: true, message: "PROFILE 已恢复默认。" };
    }
    if (section === "facts") {
      await this.input.memory.getFactsStore().clearAll();
      await this.input.memory.getFactEmbeddingStore().clearAll();
      return { accepted: true, message: "FACTS 与归档已清空。" };
    }
    const removed = await this.input.memory.getEpisodesStore().clearAll();
    return { accepted: true, message: `EPISODES 已清空（${removed} 个文件）。` };
  }

  async triggerKernelTask(taskType: "tick-now" | "daily-now"): Promise<{ accepted: boolean; message: string }> {
    if (taskType === "daily-now") {
      await this.input.kernel.runDailyNow();
      return { accepted: true, message: "已触发内核日常任务检查。" };
    }
    await this.input.kernel.runTickNow();
    return { accepted: true, message: "已触发一次内核 tick。" };
  }

  async startBilibiliQrAuth() {
    const result = await this.input.bilibiliBrowse.startQrAuth();
    await this.input.emitStatus();
    return result;
  }

  async pollBilibiliQrAuth(input: { qrcodeKey: string }) {
    const result = await this.input.bilibiliBrowse.pollQrAuth(input);
    if (result.cookieSaved) {
      await this.input.bilibiliSyncCoordinator.refresh();
    }
    await this.input.emitStatus();
    return {
      authState: result.authState,
      status: result.status,
      detail: result.detail,
      cookieSaved: result.cookieSaved
    };
  }

  async saveBilibiliCookie(input: { cookie: string }) {
    const result = await this.input.bilibiliBrowse.saveCookie(input);
    await this.input.bilibiliSyncCoordinator.refresh();
    await this.input.emitStatus();
    return result;
  }

  async triggerBilibiliSync(): Promise<{ accepted: boolean; message: string }> {
    const result = await this.input.bilibiliSyncCoordinator.triggerNow();
    await this.input.emitStatus();
    return {
      accepted: result.reason === "synced" || result.reason === "no-content",
      message:
        result.reason === "synced"
          ? "Bilibili 素材已同步。"
          : result.reason === "no-content"
            ? "Bilibili 已完成同步，但这轮没有新增素材。"
            : result.reason === "disabled"
              ? "Bilibili 同步已关闭。"
              : result.reason === "missing-cookie"
                ? "请先配置 B 站 Cookie。"
                : result.reason === "auth-expired"
                  ? result.detail ?? "Cookie 已失效，请重新扫码。"
                  : `Bilibili 同步失败：${result.detail ?? "未知错误"}`
    };
  }

  async openBilibiliAccount(): Promise<{ opened: boolean; message: string }> {
    return this.input.bilibiliBrowse.openAccountPage();
  }

  async openSystemPermissionSettings(
    permission: keyof AppStatus["systemPermissions"]
  ): Promise<{ opened: boolean; prompted: boolean }> {
    return this.input.systemPermissionsService.openSystemPermissionSettings(permission);
  }

  async resetSystemPermissions(): Promise<{ reset: boolean; message?: string }> {
    return this.input.systemPermissionsService.resetSystemPermissions();
  }

  async getConsoleChatHistory(input?: {
    cursor?: string;
    limit?: number;
  }): Promise<{
    items: HistoryMessage[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    return this.input.memory.listHistoryByCursor({
      resourceId: this.input.resourceId,
      threadId: this.input.threadId,
      beforeId: input?.cursor,
      limit: input?.limit ?? 20
    });
  }
}
