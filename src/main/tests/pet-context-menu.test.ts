import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "@shared/types";
import { buildPetContextMenuTemplate } from "../pet/context-menu.js";

test("buildPetContextMenuTemplate: exposes realtime voice controls in pet menu", () => {
  const config = {
    ...DEFAULT_CONFIG,
    realtimeVoice: {
      ...DEFAULT_CONFIG.realtimeVoice,
      enabled: true,
      mode: "free" as const,
      autoInterrupt: true,
      aecEnabled: false
    }
  };

  const template = buildPetContextMenuTemplate(config, {
    openConsole: () => undefined,
    disablePet: () => undefined,
    toggleFreeConversation: () => undefined
  });

  const freeConversationItem = template.find((item) => item.label === "自由对话");
  assert.ok(freeConversationItem);
  assert.equal(freeConversationItem?.type, "checkbox");
  assert.equal(freeConversationItem?.checked, true);
});

test("buildPetContextMenuTemplate: free conversation is off when realtime voice is disabled", () => {
  const template = buildPetContextMenuTemplate(DEFAULT_CONFIG, {
    openConsole: () => undefined,
    disablePet: () => undefined,
    toggleFreeConversation: () => undefined
  });

  const freeConversationItem = template.find((item) => item.label === "自由对话");
  assert.ok(freeConversationItem);
  assert.equal(freeConversationItem?.checked, false);
});
