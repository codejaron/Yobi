import { spawn, type ChildProcess } from "node:child_process";

export class KeepAwakeService {
  private proc: ChildProcess | null = null;

  apply(enabled: boolean): void {
    if (process.platform !== "darwin") {
      return;
    }

    if (enabled) {
      this.start();
      return;
    }

    this.stop();
  }

  isActive(): boolean {
    return Boolean(this.proc && !this.proc.killed);
  }

  stop(): void {
    if (!this.proc) {
      return;
    }

    this.proc.kill("SIGTERM");
    this.proc = null;
  }

  private start(): void {
    if (this.proc && !this.proc.killed) {
      return;
    }

    try {
      this.proc = spawn("caffeinate", ["-i"], {
        stdio: "ignore"
      });
      const proc = this.proc;
      proc.on("exit", () => {
        this.proc = null;
      });
      proc.on("error", () => {
        this.proc = null;
      });
    } catch {
      this.proc = null;
    }
  }
}
