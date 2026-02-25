import { powerSaveBlocker } from "electron";

export class KeepAwakeService {
  private blockerId: number | null = null;

  apply(enabled: boolean): void {
    if (enabled) {
      this.start();
      return;
    }

    this.stop();
  }

  isActive(): boolean {
    return this.blockerId !== null && powerSaveBlocker.isStarted(this.blockerId);
  }

  stop(): void {
    if (this.blockerId === null) {
      return;
    }

    if (powerSaveBlocker.isStarted(this.blockerId)) {
      powerSaveBlocker.stop(this.blockerId);
    }

    this.blockerId = null;
  }

  private start(): void {
    if (this.blockerId !== null && powerSaveBlocker.isStarted(this.blockerId)) {
      return;
    }

    if (this.blockerId !== null && !powerSaveBlocker.isStarted(this.blockerId)) {
      this.blockerId = null;
    }

    try {
      this.blockerId = powerSaveBlocker.start("prevent-app-suspension");
    } catch {
      this.blockerId = null;
    }
  }
}
