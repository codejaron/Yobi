import type { AppConfig } from "@shared/types";
import { KeepAwakeService } from "@main/services/keep-awake";
import { PetService } from "@main/services/pet-service";
import { ReminderService } from "@main/services/reminders";
import { BilibiliSyncCoordinator } from "@main/services/browse/bilibili-sync-coordinator";

interface LifecycleCoordinatorInput {
  keepAwake: KeepAwakeService;
  petService: PetService;
  reminderService: ReminderService;
  bilibiliSyncCoordinator: BilibiliSyncCoordinator;
  getConfig: () => AppConfig;
}

export class LifecycleCoordinator {
  constructor(private readonly input: LifecycleCoordinatorInput) {}

  async start(): Promise<void> {
    await this.input.reminderService.init();
    this.applyConfigEffects();
    await this.input.bilibiliSyncCoordinator.start();
  }

  stop(): void {
    this.input.keepAwake.stop();
    this.input.petService.stop();
    this.input.bilibiliSyncCoordinator.stop();
  }

  applyConfigEffects(): void {
    const config = this.input.getConfig();
    this.input.keepAwake.apply(config.background.keepAwake);
    this.input.petService.syncPetWindow();
    void this.input.petService.syncGlobalPetPushToTalk();
    this.input.petService.syncRealtimeVoice();
    void this.input.bilibiliSyncCoordinator.refresh();
  }

  isKeepAwakeActive(): boolean {
    return this.input.keepAwake.isActive();
  }

  isPetOnline(): boolean {
    return this.input.petService.isPetOnline();
  }
}
