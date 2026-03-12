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

  get soulPath(): string {
    return path.join(this.baseDir, "soul.md");
  }

  get relationshipPath(): string {
    return path.join(this.baseDir, "relationship.json");
  }

  get scheduledTasksPath(): string {
    return path.join(this.baseDir, "scheduled-tasks.json");
  }

  get scheduledTaskRunsPath(): string {
    return path.join(this.baseDir, "scheduled-task-runs.jsonl");
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

  get factEmbeddingsPath(): string {
    return path.join(this.memoryDir, "fact-embeddings.json");
  }

  get factsDbPath(): string {
    return path.join(this.memoryDir, "facts.sqlite");
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

  get deadLetterTasksPath(): string {
    return path.join(this.memoryDir, "dead-letter.jsonl");
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

  get modelsDir(): string {
    return path.join(this.baseDir, "models");
  }

  get embeddingModelsDir(): string {
    return path.join(this.modelsDir, "embedding");
  }

  get whisperModelsDir(): string {
    return path.join(this.modelsDir, "whisper");
  }

  get vadModelsDir(): string {
    return path.join(this.modelsDir, "vad");
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

  get skillsDir(): string {
    return path.join(this.baseDir, "skills");
  }

  get skillsRegistryPath(): string {
    return path.join(this.baseDir, "skills-registry.json");
  }

  ensureLayout(): void {
    mkdirSync(this.baseDir, { recursive: true });
    mkdirSync(this.memoryDir, { recursive: true });
    mkdirSync(this.episodesDir, { recursive: true });
    mkdirSync(this.sessionsDir, { recursive: true });
    mkdirSync(this.mainSessionDir, { recursive: true });
    mkdirSync(this.sessionArchiveDir, { recursive: true });
    mkdirSync(this.logsDir, { recursive: true });
    mkdirSync(this.modelsDir, { recursive: true });
    mkdirSync(this.embeddingModelsDir, { recursive: true });
    mkdirSync(this.whisperModelsDir, { recursive: true });
    mkdirSync(this.vadModelsDir, { recursive: true });
    mkdirSync(this.browseDir, { recursive: true });
    mkdirSync(this.bilibiliBrowseDir, { recursive: true });
    mkdirSync(this.tokenStatsDir, { recursive: true });
    mkdirSync(this.petBrowserProfileDir, { recursive: true });
    mkdirSync(this.skillsDir, { recursive: true });
  }
}
