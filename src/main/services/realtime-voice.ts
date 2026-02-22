export class RealtimeVoiceService {
  private active = false;

  start(): void {
    this.active = true;
  }

  stop(): void {
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  interrupt(): void {
    // Placeholder for future streaming audio interrupt logic.
  }
}
