import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { getPetModelMetadata } from "../pet/pet-model-metadata.js";

test("getPetModelMetadata: parses expressions from nested model3 json", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "yobi-pet-model-meta-"));

  try {
    const modelDir = path.join(baseDir, "haru");
    const runtimeDir = path.join(modelDir, "runtime");
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(
      path.join(runtimeDir, "haru.model3.json"),
      JSON.stringify(
        {
          FileReferences: {
            Expressions: [
              { Name: "Normal", File: "expressions/Normal.exp3.json" },
              { Name: "Smile", File: "expressions/Smile.exp3.json" }
            ]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const metadata = getPetModelMetadata(modelDir);

    assert.deepEqual(metadata.expressions, [
      { id: "Normal", label: "Normal" },
      { id: "Smile", label: "Smile" }
    ]);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test("getPetModelMetadata: returns empty expressions when model has none", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "yobi-pet-model-empty-"));

  try {
    const modelDir = path.join(baseDir, "simple");
    await fs.mkdir(modelDir, { recursive: true });
    await fs.writeFile(
      path.join(modelDir, "simple.model3.json"),
      JSON.stringify(
        {
          FileReferences: {
            Textures: ["texture_00.png"]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const metadata = getPetModelMetadata(modelDir);

    assert.deepEqual(metadata.expressions, []);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});
