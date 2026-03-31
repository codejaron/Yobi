import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { CompanionPaths } from "../storage/paths.js";
import { ConfigStore } from "../storage/config.js";
import { DEFAULT_CONFIG } from "@shared/types";
import { MEMORY_RUNTIME_DEFAULTS } from "@shared/runtime-tuning";

test("ConfigStore: prunes legacy openclaw context budget and embedded Exa MCP config", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "yobi-config-migrate-"));

  try {
    const paths = new CompanionPaths(baseDir);
    paths.ensureLayout();

    const legacyConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Record<string, any>;
    delete legacyConfig.tools.exa;
    legacyConfig.openclaw = {
      contextTokens: 120_000
    };
    legacyConfig.tools.mcp.servers = [
      {
        id: "exa",
        label: "Exa Search",
        enabled: false,
        transport: "remote",
        url: "https://mcp.exa.ai/mcp",
        headers: {}
      },
      {
        id: "docs",
        label: "Docs",
        enabled: true,
        transport: "remote",
        url: "https://example.com/mcp",
        headers: {
          Authorization: "Bearer demo"
        }
      }
    ];

    await fs.writeFile(paths.configPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, "utf8");

    const store = new ConfigStore(paths);
    await store.init();
    const config = store.getConfig();
    const persisted = JSON.parse(await fs.readFile(paths.configPath, "utf8")) as Record<string, any>;

    assert.equal("context" in config.memory, false);
    assert.equal("openclaw" in persisted, false);
    assert.equal(config.tools.exa.enabled, false);
    assert.equal(config.tools.mcp.servers.length, 1);
    assert.equal(config.tools.mcp.servers[0]?.id, "docs");
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test("ConfigStore: fills appearance defaults for config without theme settings", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "yobi-config-theme-"));

  try {
    const paths = new CompanionPaths(baseDir);
    paths.ensureLayout();

    const legacyConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Record<string, unknown>;
    delete legacyConfig.appearance;

    await fs.writeFile(paths.configPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, "utf8");

    const store = new ConfigStore(paths);
    await store.init();
    const config = store.getConfig();

    assert.deepEqual(config.appearance, {
      themeMode: "system"
    });
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test("ConfigStore: migrates legacy realtime voice shape without losing enabled flags", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "yobi-config-realtime-voice-"));

  try {
    const paths = new CompanionPaths(baseDir);
    paths.ensureLayout();

    const legacyConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Record<string, any>;
    legacyConfig.realtimeVoice = {
      enabled: true,
      whisperMode: "api",
      autoInterrupt: false
    };

    await fs.writeFile(paths.configPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, "utf8");

    const store = new ConfigStore(paths);
    await store.init();
    const config = store.getConfig();

    assert.equal(config.realtimeVoice.enabled, true);
    assert.equal(config.realtimeVoice.mode, "ptt");
    assert.equal(config.realtimeVoice.autoInterrupt, false);
    assert.equal(config.realtimeVoice.aecEnabled, true);
    assert.equal(config.realtimeVoice.vadThreshold, 0.5);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test("ConfigStore: fills pet expression default for configs without pet expression state", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "yobi-config-pet-expression-"));

  try {
    const paths = new CompanionPaths(baseDir);
    paths.ensureLayout();

    const legacyConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Record<string, any>;
    delete legacyConfig.pet.expressionId;

    await fs.writeFile(paths.configPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, "utf8");

    const store = new ConfigStore(paths);
    await store.init();
    const config = store.getConfig();

    assert.equal(config.pet.expressionId, "");
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test("ConfigStore: downgrades legacy whisper-local ASR to none without resetting the rest of config", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "yobi-config-whisper-downgrade-"));

  try {
    const paths = new CompanionPaths(baseDir);
    paths.ensureLayout();

    const legacyConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Record<string, any>;
    legacyConfig.voice.asrProvider = "whisper-local";
    legacyConfig.whisperLocal = {
      enabled: true,
      modelSize: "small"
    };
    delete legacyConfig.senseVoiceLocal;
    legacyConfig.voice.ttsProvider = "alibaba";
    legacyConfig.alibabaVoice.enabled = true;
    legacyConfig.alibabaVoice.apiKey = "demo-key";

    await fs.writeFile(paths.configPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, "utf8");

    const store = new ConfigStore(paths);
    await store.init();
    const config = store.getConfig();

    assert.equal(config.voice.asrProvider, "none");
    assert.equal(config.voice.ttsProvider, "alibaba");
    assert.equal(config.alibabaVoice.apiKey, "demo-key");
    assert.equal(config.senseVoiceLocal.enabled, false);
    assert.equal(config.senseVoiceLocal.modelName, "SenseVoiceSmall-int8");
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test("ConfigStore: prunes legacy kernel runtime tuning fields from persisted config", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "yobi-config-kernel-runtime-prune-"));

  try {
    const paths = new CompanionPaths(baseDir);
    paths.ensureLayout();

    const legacyConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Record<string, any>;
    legacyConfig.kernel = {
      personality: {
        openness: 0.8,
        conscientiousness: 0.7,
        extraversion: 0.6,
        agreeableness: 0.5,
        neuroticism: 0.4
      },
      emotionSignals: {
        enabled: true,
        deltaScale: 0.4,
        energyEngagementScale: 0.1,
        connectionTrustScale: 0.9,
        ruminationThreshold: 0.2,
        ruminationMaxStages: 9,
        windowMaxAbsDelta: 0.2,
        stalenessFullEffectMinutes: 15,
        stalenessMaxAgeHours: 12,
        stalenessMinScale: 0.1
      }
    };

    await fs.writeFile(paths.configPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, "utf8");

    const store = new ConfigStore(paths);
    await store.init();
    const config = store.getConfig() as Record<string, any>;
    const persisted = JSON.parse(await fs.readFile(paths.configPath, "utf8")) as Record<string, any>;

    assert.equal("kernel" in config, false);
    assert.equal("kernel" in persisted, false);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test("ConfigStore: prunes legacy proactive timing fields while preserving supported values", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "yobi-config-proactive-prune-"));

  try {
    const paths = new CompanionPaths(baseDir);
    paths.ensureLayout();

    const legacyConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Record<string, any>;
    legacyConfig.proactive = {
      enabled: true,
      pushTargets: {
        telegram: true,
        feishu: false
      },
      quietHours: {
        enabled: false,
        startMinuteOfDay: 180,
        endMinuteOfDay: 360
      },
      coldStartDelayMs: 123_000,
      cooldownMs: 456_000,
      silenceThresholdMs: 789_000
    };

    await fs.writeFile(paths.configPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, "utf8");

    const store = new ConfigStore(paths);
    await store.init();
    const config = store.getConfig();
    const persisted = JSON.parse(await fs.readFile(paths.configPath, "utf8")) as { proactive: Record<string, unknown> };

    assert.deepEqual(config.proactive, {
      enabled: true,
      pushTargets: {
        telegram: true,
        feishu: false
      },
      quietHours: {
        enabled: false,
        startMinuteOfDay: 180,
        endMinuteOfDay: 360
      }
    });
    assert.deepEqual(persisted.proactive, config.proactive);
    assert.equal("coldStartDelayMs" in persisted.proactive, false);
    assert.equal("cooldownMs" in persisted.proactive, false);
    assert.equal("silenceThresholdMs" in persisted.proactive, false);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test("ConfigStore: prunes legacy kernel toggle and fact-extraction config", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "yobi-config-kernel-prune-"));

  try {
    const paths = new CompanionPaths(baseDir);
    paths.ensureLayout();

    const legacyConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Record<string, any>;
    legacyConfig.kernel = {
      enabled: false,
      factExtraction: {
        maxInputTokens: 2048,
        maxOutputTokens: 512,
        incrementalMessageThreshold: 12
      }
    };
    legacyConfig.modelRouting.factExtraction = {
      providerId: "anthropic-main",
      model: "claude-3-5-haiku-latest"
    };

    await fs.writeFile(paths.configPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, "utf8");

    const store = new ConfigStore(paths);
    await store.init();
    const config = store.getConfig() as Record<string, any>;
    const persisted = JSON.parse(await fs.readFile(paths.configPath, "utf8")) as Record<string, any>;

    assert.equal("kernel" in config, false);
    assert.equal("factExtraction" in config.modelRouting, false);
    assert.equal("kernel" in persisted, false);
    assert.equal("factExtraction" in persisted.modelRouting, false);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test("ConfigStore: keeps only advanced memory tuning fields in persisted config", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "yobi-config-memory-tuning-prune-"));

  try {
    const paths = new CompanionPaths(baseDir);
    paths.ensureLayout();

    const legacyConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Record<string, any>;
    legacyConfig.memory.context = {
      memoryFloorTokens: 2222,
      maxPromptTokens: 12345
    };
    legacyConfig.memory.embedding.enabled = false;
    legacyConfig.memory.embedding.modelId = "custom.gguf";
    legacyConfig.memory.embedding.similarityThreshold = 0.2;
    legacyConfig.kernel = {
      tick: {
        activeIntervalMs: 1111,
        warmIntervalMs: 2222,
        idleIntervalMs: 3333,
        quietIntervalMs: 4444
      }
    };

    await fs.writeFile(paths.configPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, "utf8");

    const store = new ConfigStore(paths);
    await store.init();
    const config = store.getConfig() as Record<string, any>;
    const persisted = JSON.parse(await fs.readFile(paths.configPath, "utf8")) as Record<string, any>;

    assert.equal(config.memory.recentMessages, DEFAULT_CONFIG.memory.recentMessages);
    assert.equal(config.memory.cognitionBatchRounds, DEFAULT_CONFIG.memory.cognitionBatchRounds);
    assert.equal(config.memory.embedding.enabled, false);
    assert.equal(config.memory.embedding.similarityThreshold, 0.2);
    assert.equal("context" in config.memory, false);
    assert.equal("modelId" in config.memory.embedding, false);
    assert.equal("kernel" in config, false);

    assert.equal("context" in persisted.memory, false);
    assert.equal(persisted.memory.cognitionBatchRounds, DEFAULT_CONFIG.memory.cognitionBatchRounds);
    assert.equal(persisted.memory.embedding.enabled, false);
    assert.equal("modelId" in persisted.memory.embedding, false);
    assert.equal("kernel" in persisted, false);
    assert.equal(
      DEFAULT_CONFIG.memory.embedding.similarityThreshold,
      MEMORY_RUNTIME_DEFAULTS.embedding.similarityThreshold
    );
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});
