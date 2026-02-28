import type { WorkingMemoryDocument } from "@shared/types";
import { YobiMemory } from "./setup";

export class WorkingMemoryService {
  constructor(
    private readonly memory: YobiMemory,
    private readonly resourceId: string,
    private readonly threadId: string
  ) {}

  async getWorkingMemory(): Promise<WorkingMemoryDocument> {
    return this.memory.getWorkingMemory({
      resourceId: this.resourceId,
      threadId: this.threadId
    });
  }

  async saveWorkingMemory(markdown: string): Promise<WorkingMemoryDocument> {
    return this.memory.saveWorkingMemory({
      resourceId: this.resourceId,
      threadId: this.threadId,
      markdown
    });
  }
}
