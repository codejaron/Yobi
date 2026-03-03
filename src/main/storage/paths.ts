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

  get runtimeContextPath(): string {
    return path.join(this.baseDir, "runtime-context.json");
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

  get browseDir(): string {
    return path.join(this.baseDir, "browse");
  }

  get bilibiliBrowseDir(): string {
    return path.join(this.browseDir, "bilibili");
  }

  get bilibiliFeedPath(): string {
    return path.join(this.bilibiliBrowseDir, "feed.json");
  }

  get bilibiliHotlistPath(): string {
    return path.join(this.bilibiliBrowseDir, "hotlist.json");
  }

  get bilibiliWatchedPath(): string {
    return path.join(this.bilibiliBrowseDir, "watched.json");
  }

  get bilibiliBrowseStatePath(): string {
    return path.join(this.bilibiliBrowseDir, "state.json");
  }

  get tokenStatsDir(): string {
    return path.join(this.baseDir, "token-stats");
  }

  get tokenStatsStatePath(): string {
    return path.join(this.tokenStatsDir, "state.json");
  }

  ensureLayout(): void {
    mkdirSync(this.baseDir, { recursive: true });
    mkdirSync(this.charactersDir, { recursive: true });
    mkdirSync(this.logsDir, { recursive: true });
    mkdirSync(this.modelsDir, { recursive: true });
    mkdirSync(this.openclawStateDir, { recursive: true });
    mkdirSync(this.browseDir, { recursive: true });
    mkdirSync(this.bilibiliBrowseDir, { recursive: true });
    mkdirSync(this.tokenStatsDir, { recursive: true });
  }
}
