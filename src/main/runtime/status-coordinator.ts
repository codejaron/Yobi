import type { AppStatus } from "@shared/types";
import type { BilibiliBrowseService } from "@main/services/browse/bilibili-browse-service";
import type { TokenStatsService } from "@main/services/token/token-stats-service";
import type { YobiMemory } from "@main/memory/setup";
import type { KernelEngine } from "@main/kernel/engine";
import type { SystemPermissionsService } from "@main/services/system-permissions";
import type { RuntimeActivityCoordinator } from "@main/runtime/activity-coordinator";
import type { ChannelCoordinator } from "@main/runtime/channel-coordinator";
import type { ClawCoordinator } from "@main/runtime/claw-coordinator";
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
  clawCoordinator: ClawCoordinator;
  lifecycleCoordinator: LifecycleCoordinator;
  resourceId: string;
  threadId: string;
}

export class RuntimeStatusCoordinator {
  constructor(private readonly input: StatusCoordinatorInput) {}

  async collectStatus(): Promise<AppStatus> {
    this.input.systemPermissionsService.refreshSystemPermissions();
    const openclawStatus = this.input.clawCoordinator.getOpenClawStatus();
    const [browseStatus, tokenStats, historyCount, topicPool] = await Promise.allSettled([
      this.input.bilibiliBrowse.getStatus(),
      this.input.tokenStatsService.getStatus(),
      this.input.memory.countHistory({
        resourceId: this.input.resourceId,
        threadId: this.input.threadId
      }),
      this.input.memory.listTopicPool(50)
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
      topicPool: topicPool.status === "fulfilled" ? topicPool.value : [],
      petOnline: this.input.lifecycleCoordinator.isPetOnline(),
      openclawOnline: openclawStatus.online,
      openclawStatus: openclawStatus.message,
      browseStatus:
        browseStatus.status === "fulfilled"
          ? browseStatus.value
          : {
              authState: "error",
              lastNavCheckAt: null,
              lastCollectAt: null,
              lastDigestAt: null,
              todayTokenUsed: 0,
              todayEventShares: 0,
              pausedReason: "状态加载失败"
            },
      tokenStats:
        tokenStats.status === "fulfilled"
          ? tokenStats.value
          : {
              retentionDays: 90,
              lastUpdatedAt: null,
              days: [],
              integrations: {
                claw: "pending"
              }
            },
      systemPermissions: this.input.systemPermissionsService.getSnapshot(),
      embedder: this.input.memory.getEmbedderStatus(),
      backgroundWorker: this.input.kernel.getBackgroundWorkerStatus(),
      kernel: this.input.kernel.getStatus()
    };
  }
}
