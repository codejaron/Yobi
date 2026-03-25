import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { CompanionPaths } from "../storage/paths.js";
import { ProfileSemanticTaskHandler, DailyReflectionTaskHandler } from "../kernel/task-handlers.js";
import { appLogger } from "../runtime/singletons.js";
import { DEFAULT_CONFIG, DEFAULT_USER_PROFILE, type PendingTask, type AppConfig } from "@shared/types";

function cloneConfig(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

async function createTempPaths(prefix: string): Promise<CompanionPaths> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const paths = new CompanionPaths(baseDir);
  paths.ensureLayout();
  return paths;
}

async function cleanupPaths(paths: CompanionPaths): Promise<void> {
  await fs.rm(paths.baseDir, { recursive: true, force: true });
}

function createTask(type: PendingTask["type"]): PendingTask {
  const now = new Date().toISOString();
  return {
    id: `${type}-task`,
    type,
    status: "pending",
    payload: { dayKey: "2026-03-24" },
    available_at: now,
    attempts: 0,
    created_at: now,
    updated_at: now
  };
}

test("ProfileSemanticTaskHandler logs worker failures before rethrowing", async () => {
  const paths = await createTempPaths("yobi-profile-handler-log-");
  const config = cloneConfig();
  const warnings: Array<{ module: string; event: string; detail?: Record<string, unknown> }> = [];
  const originalWarn = appLogger.warn;
  appLogger.warn = ((module: string, event: string, detail?: Record<string, unknown>) => {
    warnings.push({ module, event, detail });
  }) as typeof appLogger.warn;

  try {
    const handler = new ProfileSemanticTaskHandler({
      paths,
      memory: {
        getProfile: async () => DEFAULT_USER_PROFILE,
        listRecentEpisodes: async () => [
          {
            date: "2026-03-24",
            summary: "summary"
          }
        ],
        getProfileStore: () => ({
          applySemanticPatch: async () => undefined
        })
      } as any,
      getConfig: () => config,
      backgroundWorker: {
        runProfileSemantic: async () => {
          throw new Error("worker-boom");
        }
      } as any,
      resourceId: "main",
      threadId: "main"
    });

    await assert.rejects(() => handler.handle(createTask("profile-semantic-update")), /worker-boom/);
    assert.equal(warnings[0]?.module, "kernel");
    assert.equal(warnings[0]?.event, "profile-semantic-update-failed");
    assert.equal(warnings[0]?.detail?.episodeCount, 1);
  } finally {
    appLogger.warn = originalWarn;
    await cleanupPaths(paths);
  }
});

test("DailyReflectionTaskHandler logs worker failures before rethrowing", async () => {
  const paths = await createTempPaths("yobi-reflection-handler-log-");
  const config = cloneConfig();
  const warnings: Array<{ module: string; event: string; detail?: Record<string, unknown> }> = [];
  const originalWarn = appLogger.warn;
  appLogger.warn = ((module: string, event: string, detail?: Record<string, unknown>) => {
    warnings.push({ module, event, detail });
  }) as typeof appLogger.warn;

  try {
    const handler = new DailyReflectionTaskHandler({
      paths,
      memory: {
        listRecentEpisodes: async () => [
          {
            date: "2026-03-24",
            summary: "summary",
            significance: 0.7
          }
        ],
        getProfileStore: () => ({
          applySemanticPatch: async () => undefined
        })
      } as any,
      getConfig: () => config,
      backgroundWorker: {
        runDailyReflection: async () => {
          throw new Error("worker-boom");
        }
      } as any,
      resourceId: "main",
      threadId: "main"
    });

    await assert.rejects(() => handler.handle(createTask("daily-reflection")), /worker-boom/);
    assert.equal(warnings[0]?.module, "kernel");
    assert.equal(warnings[0]?.event, "daily-reflection-failed");
    assert.equal(warnings[0]?.detail?.episodeCount, 1);
  } finally {
    appLogger.warn = originalWarn;
    await cleanupPaths(paths);
  }
});
