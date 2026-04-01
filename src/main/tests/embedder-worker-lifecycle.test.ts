import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CompanionPaths } from "../storage/paths.js";
import { EmbedderService } from "../memory-v2/embedder.js";

test("embedder: intentionally disposed worker exit does not overwrite current status", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "yobi-embedder-worker-"));
  const service = new EmbedderService(new CompanionPaths(baseDir), () => true) as any;
  const worker = {
    kill: () => undefined
  };

  service.worker = worker;
  service.status = "ready";
  service.errorMessage = "llama-local-embedder";

  service.markWorkerForDisposal(worker);
  service.handleWorkerExit(worker, 0);

  assert.equal(service.status, "ready");
  assert.equal(service.errorMessage, "llama-local-embedder");
  assert.equal(service.worker, null);
});
