import {
  DEFAULT_CONTEXT,
  type RuntimeContext
} from "@shared/types";
import { CompanionPaths } from "./paths";
import { fileExists, readJsonFile, writeJsonFile } from "./fs";

export class ContextStore {
  private cached: RuntimeContext = DEFAULT_CONTEXT;

  constructor(private readonly paths: CompanionPaths) {}

  async init(): Promise<void> {
    const exists = await fileExists(this.paths.contextPath);
    if (!exists) {
      this.cached = DEFAULT_CONTEXT;
      await writeJsonFile(this.paths.contextPath, this.cached);
      return;
    }

    const raw = await readJsonFile<RuntimeContext>(this.paths.contextPath, DEFAULT_CONTEXT);
    this.cached = {
      ...DEFAULT_CONTEXT,
      ...raw
    };
    await writeJsonFile(this.paths.contextPath, this.cached);
  }

  get(): RuntimeContext {
    return this.cached;
  }

  async patch(patch: Partial<RuntimeContext>): Promise<RuntimeContext> {
    this.cached = {
      ...this.cached,
      ...patch
    };
    await writeJsonFile(this.paths.contextPath, this.cached);
    return this.cached;
  }
}
