import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { CompanionPaths } from "../storage/paths.js";
import { SkillManager } from "../skills/manager.js";
import { buildSkillsCatalogPrompt } from "../skills/catalog.js";
import type { SkillCatalogItem } from "@shared/types";

async function createTempPaths(prefix: string): Promise<CompanionPaths> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const paths = new CompanionPaths(baseDir);
  paths.ensureLayout();
  return paths;
}

async function writeSkill(
  skillsDir: string,
  dirname: string,
  markdown: string,
  extras?: Array<{ relativePath: string; content: string }>
): Promise<void> {
  const dir = path.join(skillsDir, dirname);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `${markdown.trim()}\n`, "utf8");

  for (const extra of extras ?? []) {
    const target = path.join(dir, extra.relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, extra.content, "utf8");
  }
}

function makeCatalogItem(input: Partial<SkillCatalogItem> & Pick<SkillCatalogItem, "id" | "name" | "description">): SkillCatalogItem {
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    version: input.version ?? null,
    tags: input.tags ?? [],
    enabled: input.enabled ?? true,
    directoryPath: input.directoryPath ?? `/tmp/${input.id}`,
    markdownPath: input.markdownPath ?? `/tmp/${input.id}/SKILL.md`,
    compatibility: input.compatibility ?? {
      status: "compatible",
      issues: []
    },
    resourceEntries: input.resourceEntries ?? [],
    metadata: input.metadata ?? {},
    markdownPreview: input.markdownPreview ?? null
  };
}

test("SkillManager: scans direct child skills and falls back without frontmatter", async () => {
  const paths = await createTempPaths("yobi-skills-");

  try {
    await writeSkill(
      paths.skillsDir,
      "alpha-skill",
      `---
name: Alpha Skill
description: Solve alpha tasks
version: 1.2.3
tags:
  - alpha
  - test
allowed-tools:
  - file
---

# Alpha

Detailed body`,
      [
        {
          relativePath: "scripts/run.sh",
          content: "#!/bin/sh\necho alpha\n"
        },
        {
          relativePath: "references/guide.md",
          content: "Alpha guide"
        }
      ]
    );

    await writeSkill(
      paths.skillsDir,
      "beta-skill",
      `# Beta helper

Beta summary paragraph.

More details later.`,
      [
        {
          relativePath: "templates/sample.txt",
          content: "hello"
        }
      ]
    );

    await writeSkill(
      path.join(paths.skillsDir, "grouped"),
      "nested-skill",
      `---
name: Nested
description: Should not be scanned
---`
    );

    const manager = new SkillManager(paths);
    await manager.init();

    const skills = await manager.listSkills();
    assert.equal(skills.length, 2);

    const alpha = skills.find((item) => item.name === "Alpha Skill");
    const beta = skills.find((item) => item.id === "beta-skill");

    assert.ok(alpha);
    assert.equal(alpha?.description, "Solve alpha tasks");
    assert.equal(alpha?.compatibility.status, "partial");
    assert.ok(alpha?.resourceEntries.some((item) => item.kind === "script" && item.relativePath === "scripts/run.sh"));
    assert.ok(alpha?.resourceEntries.some((item) => item.kind === "reference" && item.relativePath === "references/guide.md"));

    assert.ok(beta);
    assert.equal(beta?.name, "beta-skill");
    assert.equal(beta?.description, "Beta summary paragraph.");
    assert.equal(beta?.compatibility.status, "compatible");
  } finally {
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});

test("buildSkillsCatalogPrompt: truncates descriptions before omitting entries", () => {
  const verbose = Array.from({ length: 900 }, (_, index) => `token-${index}`).join(" ");
  const skills = [
    makeCatalogItem({
      id: "alpha",
      name: "Alpha",
      description: verbose
    }),
    makeCatalogItem({
      id: "beta",
      name: "Beta",
      description: verbose
    }),
    makeCatalogItem({
      id: "gamma",
      name: "Gamma",
      description: verbose
    })
  ];

  const result = buildSkillsCatalogPrompt(skills, 160);

  assert.equal(result.summary.enabledCount, 3);
  assert.equal(result.summary.truncated, true);
  assert.ok(result.summary.truncatedDescriptions >= 1);
  assert.ok(result.prompt.includes("<available_skills>"));
  assert.ok(result.prompt.includes('id="alpha"'));
  assert.ok(result.prompt.includes('name="Alpha"'));
  assert.ok(result.prompt.includes("CATALOG_TRUNCATED"));
});

test("SkillManager: disabled skills cannot activate and resource reads block traversal", async () => {
  const paths = await createTempPaths("yobi-skills-activate-");

  try {
    await writeSkill(
      paths.skillsDir,
      "runner",
      `---
name: Runner
description: Runs scripts
---

# Runner`,
      [
        {
          relativePath: "references/guide.md",
          content: "guide"
        }
      ]
    );

    const manager = new SkillManager(paths);
    await manager.init();
    const skills = await manager.listSkills();
    const runner = skills.find((item) => item.id === "runner");
    assert.ok(runner);

    await assert.rejects(
      () => manager.readSkillResource("runner", "../outside.txt"),
      /路径|relativePath|outside/i
    );

    await manager.setSkillEnabled("runner", false);

    await assert.rejects(() => manager.activateSkill("runner"), /未启用|disabled/i);
  } finally {
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});

test("SkillManager: deleteSkill removes directory and registry entry", async () => {
  const paths = await createTempPaths("yobi-skills-delete-");

  try {
    await writeSkill(
      paths.skillsDir,
      "erasable",
      `---
name: Erasable
description: Can be deleted
---`
    );

    const manager = new SkillManager(paths);
    await manager.init();

    const before = await manager.listSkills();
    assert.equal(before.some((item) => item.id === "erasable"), true);

    const removed = await manager.deleteSkill("erasable");
    assert.equal(removed.removed, true);
    assert.equal(removed.skillId, "erasable");

    const after = await manager.listSkills();
    assert.equal(after.some((item) => item.id === "erasable"), false);

    const skillDirExists = await fs.access(path.join(paths.skillsDir, "erasable")).then(() => true).catch(() => false);
    assert.equal(skillDirExists, false);
  } finally {
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  }
});
