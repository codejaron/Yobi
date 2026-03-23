import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, type AppConfig } from "@shared/types";
import { shouldDispatchAutomationMessage } from "../runtime/proactive-policy.js";

function cloneConfig(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

test("shouldDispatchAutomationMessage blocks proactive cognition sends when proactive is disabled", () => {
  const config = cloneConfig();
  config.proactive.enabled = false;

  assert.equal(
    shouldDispatchAutomationMessage({
      metadata: {
        proactive: true
      },
      proactiveConfig: config.proactive,
      now: new Date(2026, 2, 10, 12, 0, 0)
    }),
    false
  );
});

test("shouldDispatchAutomationMessage blocks proactive cognition sends during quiet hours", () => {
  const config = cloneConfig();
  config.proactive.enabled = true;
  config.proactive.quietHours = {
    enabled: true,
    startMinuteOfDay: 60,
    endMinuteOfDay: 420
  };

  assert.equal(
    shouldDispatchAutomationMessage({
      metadata: {
        proactive: true
      },
      proactiveConfig: config.proactive,
      now: new Date(2026, 2, 10, 1, 30, 0)
    }),
    false
  );
});

test("shouldDispatchAutomationMessage does not apply proactive gating to scheduled notifications", () => {
  const config = cloneConfig();
  config.proactive.enabled = false;
  config.proactive.quietHours = {
    enabled: true,
    startMinuteOfDay: 60,
    endMinuteOfDay: 420
  };

  assert.equal(
    shouldDispatchAutomationMessage({
      metadata: {
        proactive: false
      },
      proactiveConfig: config.proactive,
      now: new Date(2026, 2, 10, 1, 30, 0)
    }),
    true
  );
  assert.equal(
    shouldDispatchAutomationMessage({
      metadata: {},
      proactiveConfig: config.proactive,
      now: new Date(2026, 2, 10, 1, 30, 0)
    }),
    true
  );
});
