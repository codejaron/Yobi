import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "@shared/types";
import {
  shouldUseLegacySerialPtt,
  shouldUseUnifiedRealtimeVoice
} from "../services/pet-voice-mode.js";

test("pet voice mode: free realtime uses unified runtime", () => {
  const config = {
    ...DEFAULT_CONFIG,
    realtimeVoice: {
      ...DEFAULT_CONFIG.realtimeVoice,
      enabled: true,
      mode: "free" as const
    }
  };

  assert.equal(shouldUseUnifiedRealtimeVoice(config), true);
  assert.equal(shouldUseLegacySerialPtt(config), false);
});

test("pet voice mode: ptt remains legacy serial even when realtime voice is enabled", () => {
  const config = {
    ...DEFAULT_CONFIG,
    realtimeVoice: {
      ...DEFAULT_CONFIG.realtimeVoice,
      enabled: true,
      mode: "ptt" as const
    }
  };

  assert.equal(shouldUseUnifiedRealtimeVoice(config), false);
  assert.equal(shouldUseLegacySerialPtt(config), true);
});

test("pet voice mode: disabled realtime voice uses legacy serial path", () => {
  const config = {
    ...DEFAULT_CONFIG,
    realtimeVoice: {
      ...DEFAULT_CONFIG.realtimeVoice,
      enabled: false,
      mode: "free" as const
    }
  };

  assert.equal(shouldUseUnifiedRealtimeVoice(config), false);
  assert.equal(shouldUseLegacySerialPtt(config), true);
});
