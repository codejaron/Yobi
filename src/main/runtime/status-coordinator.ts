import type { AppStatus } from "@shared/types";
import type { BilibiliBrowseService } from "@main/services/browse/bilibili-browse-service";
import type { TokenStatsService } from "@main/services/token/token-stats-service";
import type { YobiMemory } from "@main/memory/setup";
import type { KernelEngine } from "@main/kernel/engine";
import type { SystemPermissionsService } from "@main/services/system-permissions";
import type { RuntimeActivityCoordinator } from "@main/runtime/activity-coordinator";
import type { ChannelCoordinator } from "@main/runtime/channel-coordinator";
import type { LifecycleCoordinator } from "@main/runtime/lifecycle-coordinator";

interface StatusCoordinatorInput {
  bootedAt: string;
  memory: YobiMemory;
  kernel: KernelEngine;
  bilibiliBrowse: BilibiliBrowseService;
  tokenStatsService: TokenStatsService;
  systemPermissionsService: SystemPermissionsService;
  activityCoordinator: RuntimeActivityCoordinator;
  channelCoordinator: ChannelCoordinator;
  lifecycleCoordinator: LifecycleCoordinator;
  resourceId: string;
  threadId: string;
}

export class RuntimeStatusCoordinator {
  constructor(private readonly input: StatusCoordinatorInput) {}

  async collectStatus(): Promise<AppStatus> {
    this.input.systemPermissionsService.refreshSystemPermissions();
    const [browseStatus, tokenStats, historyCount] = await Promise.allSettled([
      this.input.bilibiliBrowse.getStatus(),
      this.input.tokenStatsService.getStatus(),
      this.input.memory.countHistory({
        resourceId: this.input.resourceId,
        threadId: this.input.threadId
      })
    ]);
    const activity = this.input.activityCoordinator.getSnapshot();
    return {
      bootedAt: this.input.bootedAt,
      telegramConnected: this.input.channelCoordinator.getTelegramChannel().isConnected(),
      qqConnected: this.input.channelCoordinator.isQQConnected(),
      feishuConnected: this.input.channelCoordinator.getFeishuChannel().isConnected(),
      lastUserAt: activity.lastUserAt,
      lastProactiveAt: activity.lastProactiveAt,
      historyCount: historyCount.status === "fulfilled" ? historyCount.value : 0,
      keepAwakeActive: this.input.lifecycleCoordinator.isKeepAwakeActive(),
      petOnline: this.input.lifecycleCoordinator.isPetOnline(),
      browseStatus:
        browseStatus.status === "fulfilled"
          ? browseStatus.value
          : {
              authState: "error",
              lastNavCheckAt: null,
              lastSyncAt: null,
              preferenceFactCount: 0,
              recentFactCount: 0,
              lastAutoFollowAt: null,
              autoFollowTodayCount: 0,
              recentAutoFollows: [],
              pausedReason: "状态加载失败"
            },
      tokenStats:
        tokenStats.status === "fulfilled"
          ? tokenStats.value
          : {
              retentionDays: 90,
              lastUpdatedAt: null,
              days: []
            },
      systemPermissions: this.input.systemPermissionsService.getSnapshot(),
      embedder: this.input.memory.getEmbedderStatus(),
      backgroundWorker: this.input.kernel.getBackgroundWorkerStatus(),
      kernel: this.input.kernel.getStatus()
    };
  }
}
