import { homedir } from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";

export class CompanionPaths {
  readonly baseDir: string;

  constructor(baseDir = path.join(homedir(), ".yobi")) {
    this.baseDir = baseDir;
  }

  get configPath(): string {
    return path.join(this.baseDir, "config.json");
  }

  get charactersDir(): string {
    return path.join(this.baseDir, "characters");
  }

  get defaultCharacterPath(): string {
    return path.join(this.charactersDir, "default.json");
  }

  get remindersPath(): string {
    return path.join(this.baseDir, "reminders.json");
  }

  get backgroundTaskStatePath(): string {
    return path.join(this.baseDir, "background-tasks.json");
  }

  get logsDir(): string {
    return path.join(this.baseDir, "logs");
  }

  get modelsDir(): string {
    return path.join(this.baseDir, "models");
  }

  get yobiDbPath(): string {
    return path.join(this.baseDir, "yobi.db");
  }

  get openclawStateDir(): string {
    return path.join(this.baseDir, "openclaw");
  }

  get openclawConfigPath(): string {
    return path.join(this.openclawStateDir, "openclaw.json");
  }

  get openclawSyncStatePath(): string {
    return path.join(this.openclawStateDir, "yobi-sync-state.json");
  }

  ensureLayout(): void {
    mkdirSync(this.baseDir, { recursive: true });
    mkdirSync(this.charactersDir, { recursive: true });
    mkdirSync(this.logsDir, { recursive: true });
    mkdirSync(this.modelsDir, { recursive: true });
    mkdirSync(this.openclawStateDir, { recursive: true });
  }
}
