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

  get sessionDir(): string {
    return path.join(this.baseDir, "sessions", "main");
  }

  get historyPath(): string {
    return path.join(this.sessionDir, "history.jsonl");
  }

  get memoryPath(): string {
    return path.join(this.sessionDir, "memory.json");
  }

  get contextPath(): string {
    return path.join(this.sessionDir, "context.json");
  }

  get remindersPath(): string {
    return path.join(this.sessionDir, "reminders.json");
  }

  get logsDir(): string {
    return path.join(this.baseDir, "logs");
  }

  get modelsDir(): string {
    return path.join(this.baseDir, "models");
  }

  ensureLayout(): void {
    mkdirSync(this.baseDir, { recursive: true });
    mkdirSync(this.charactersDir, { recursive: true });
    mkdirSync(this.sessionDir, { recursive: true });
    mkdirSync(this.logsDir, { recursive: true });
    mkdirSync(this.modelsDir, { recursive: true });
  }
}
