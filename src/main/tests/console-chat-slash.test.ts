import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, type SkillCatalogItem } from "@shared/types";
import {
  buildConsoleSlashCommandItems,
  filterConsoleSlashCommandItems,
  getConsoleSlashQuery,
  getNextConsoleSlashIndex,
  isConsoleSlashDraft
} from "@shared/console-chat-slash";

function createSkill(input: Partial<SkillCatalogItem> & Pick<SkillCatalogItem, "id" | "name">): SkillCatalogItem {
  return {
    id: input.id,
    name: input.name,
    description: input.description ?? "",
    version: input.version ?? null,
    tags: input.tags ?? [],
    enabled: input.enabled ?? false,
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

test("isConsoleSlashDraft only matches drafts whose first non-whitespace character is slash", () => {
  assert.equal(isConsoleSlashDraft("/skill"), true);
  assert.equal(isConsoleSlashDraft("   /pet"), true);
  assert.equal(isConsoleSlashDraft("hello /skill"), false);
  assert.equal(isConsoleSlashDraft(""), false);
});

test("getConsoleSlashQuery trims the leading slash and surrounding whitespace", () => {
  assert.equal(getConsoleSlashQuery(" /skill painter "), "skill painter");
  assert.equal(getConsoleSlashQuery("/"), "");
  assert.equal(getConsoleSlashQuery("hello"), "");
});

test("buildConsoleSlashCommandItems builds dynamic toggle commands and sorts enabled skills first", () => {
  const items = buildConsoleSlashCommandItems({
    config: {
      ...DEFAULT_CONFIG,
      proactive: {
        ...DEFAULT_CONFIG.proactive,
        enabled: false
      }
    },
    skills: [
      createSkill({ id: "skill-b", name: "Beta Skill", enabled: false }),
      createSkill({ id: "skill-a", name: "Alpha Skill", enabled: true })
    ]
  });

  assert.deepEqual(
    items.map((item) => item.id),
    ["command:proactive", "command:pet", "skill:skill-a", "skill:skill-b"]
  );
  assert.equal(items[0]?.label, "开启主动聊天");
  assert.equal(items[0]?.action.type, "toggle-proactive");
  assert.equal(items[0]?.action.nextEnabled, true);
});

test("filterConsoleSlashCommandItems narrows results with multi-token slash queries", () => {
  const items = buildConsoleSlashCommandItems({
    config: DEFAULT_CONFIG,
    skills: [
      createSkill({ id: "skill-vision", name: "Vision Helper", description: "image workflow", enabled: true }),
      createSkill({ id: "skill-audio", name: "Audio Helper", description: "voice workflow", enabled: false })
    ]
  });

  assert.deepEqual(
    filterConsoleSlashCommandItems(items, "skill vision").map((item) => item.id),
    ["skill:skill-vision"]
  );
  assert.deepEqual(
    filterConsoleSlashCommandItems(items, "pet").map((item) => item.id),
    ["command:pet"]
  );
});

test("buildConsoleSlashCommandItems marks pet enable feedback as warning when no model is configured", () => {
  const items = buildConsoleSlashCommandItems({
    config: {
      ...DEFAULT_CONFIG,
      pet: {
        ...DEFAULT_CONFIG.pet,
        enabled: false,
        modelDir: ""
      }
    },
    skills: []
  });

  const pet = items.find((item) => item.id === "command:pet");
  assert.ok(pet);
  assert.equal(pet.action.type, "toggle-pet");
  assert.equal(pet.action.nextEnabled, true);
  assert.deepEqual(pet.action.feedback, {
    tone: "warn",
    message: "已开启桌宠，但模型未导入"
  });
});

test("getNextConsoleSlashIndex wraps around visible command items", () => {
  assert.equal(getNextConsoleSlashIndex(0, -1, 3), 2);
  assert.equal(getNextConsoleSlashIndex(2, 1, 3), 0);
  assert.equal(getNextConsoleSlashIndex(1, 1, 0), 0);
});
