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

  get soulPath(): string {
    return path.join(this.baseDir, "soul.md");
  }

  get personaPath(): string {
    return path.join(this.baseDir, "persona.md");
  }

  get statePath(): string {
    return path.join(this.baseDir, "state.json");
  }

  get runtimeContextPath(): string {
    return path.join(this.baseDir, "runtime-context.json");
  }

  get logsDir(): string {
    return path.join(this.baseDir, "logs");
  }

  get memoryDir(): string {
    return path.join(this.baseDir, "memory");
  }

  get factsPath(): string {
    return path.join(this.memoryDir, "facts.json");
  }

  get factsArchivePath(): string {
    return path.join(this.memoryDir, "facts-archive.json");
  }

  get profilePath(): string {
    return path.join(this.memoryDir, "profile.json");
  }

  get episodesDir(): string {
    return path.join(this.memoryDir, "episodes");
  }

  get reflectionQueuePath(): string {
    return path.join(this.memoryDir, "reflection-queue.json");
  }

  get reflectionLogPath(): string {
    return path.join(this.memoryDir, "reflection-log.json");
  }

  get pendingTasksPath(): string {
    return path.join(this.memoryDir, "pending-tasks.jsonl");
  }

  get sessionsDir(): string {
    return path.join(this.baseDir, "sessions");
  }

  get mainSessionDir(): string {
    return path.join(this.sessionsDir, "main");
  }

  get bufferPath(): string {
    return path.join(this.mainSessionDir, "buffer.jsonl");
  }

  get unprocessedPath(): string {
    return path.join(this.mainSessionDir, "unprocessed.jsonl");
  }

  get sessionArchiveDir(): string {
    return path.join(this.mainSessionDir, "archive");
  }

  get topicsDir(): string {
    return path.join(this.baseDir, "topics");
  }

  get topicPoolPath(): string {
    return path.join(this.topicsDir, "pool.json");
  }

  get topicInterestProfilePath(): string {
    return path.join(this.topicsDir, "interest-profile.json");
  }

  get modelsDir(): string {
    return path.join(this.baseDir, "models");
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

  get petBrowserProfileDir(): string {
    return path.join(this.baseDir, "browser-profile");
  }

  ensureLayout(): void {
    mkdirSync(this.baseDir, { recursive: true });
    mkdirSync(this.charactersDir, { recursive: true });
    mkdirSync(this.memoryDir, { recursive: true });
    mkdirSync(this.episodesDir, { recursive: true });
    mkdirSync(this.sessionsDir, { recursive: true });
    mkdirSync(this.mainSessionDir, { recursive: true });
    mkdirSync(this.sessionArchiveDir, { recursive: true });
    mkdirSync(this.topicsDir, { recursive: true });
    mkdirSync(this.logsDir, { recursive: true });
    mkdirSync(this.modelsDir, { recursive: true });
    mkdirSync(this.openclawStateDir, { recursive: true });
    mkdirSync(this.browseDir, { recursive: true });
    mkdirSync(this.bilibiliBrowseDir, { recursive: true });
    mkdirSync(this.tokenStatsDir, { recursive: true });
    mkdirSync(this.petBrowserProfileDir, { recursive: true });
  }
}
