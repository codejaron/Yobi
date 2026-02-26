import { appConfigSchema, DEFAULT_CONFIG, type AppConfig } from "@shared/types";
import { CompanionPaths } from "./paths";
import { fileExists, readJsonFile, writeJsonFile } from "./fs";

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function normalizeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function normalizeHotkey(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value
    .split("+")
    .map((item) => item.trim())
    .filter(Boolean)
    .join("+");

  return normalized || fallback;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

export class ConfigStore {
  private cached: AppConfig = DEFAULT_CONFIG;

  constructor(private readonly paths: CompanionPaths) {}

  async init(): Promise<void> {
    this.paths.ensureLayout();

    const exists = await fileExists(this.paths.configPath);
    if (!exists) {
      this.cached = DEFAULT_CONFIG;
      await writeJsonFile(this.paths.configPath, this.cached);
      return;
    }

    const raw = await readJsonFile<AppConfig>(this.paths.configPath, DEFAULT_CONFIG);
    const merged = {
      ...DEFAULT_CONFIG,
      ...raw,
      telegram: {
        ...DEFAULT_CONFIG.telegram,
        ...raw.telegram
      },
      messaging: {
        ...DEFAULT_CONFIG.messaging,
        ...raw.messaging
      },
      perception: {
        ...DEFAULT_CONFIG.perception,
        ...raw.perception
      },
      voice: {
        ...DEFAULT_CONFIG.voice,
        ...raw.voice
      },
      alibabaVoice: {
        ...DEFAULT_CONFIG.alibabaVoice,
        ...raw.alibabaVoice
      },
      background: {
        ...DEFAULT_CONFIG.background,
        ...raw.background
      },
      pet: {
        ...DEFAULT_CONFIG.pet,
        ...raw.pet
      },
      ptt: {
        ...DEFAULT_CONFIG.ptt,
        ...raw.ptt
      },
      realtimeVoice: {
        ...DEFAULT_CONFIG.realtimeVoice,
        ...raw.realtimeVoice
      },
      proactive: {
        ...DEFAULT_CONFIG.proactive,
        ...raw.proactive
      },
      memory: {
        ...DEFAULT_CONFIG.memory,
        ...raw.memory
      },
      tools: {
        browser: {
          ...DEFAULT_CONFIG.tools.browser,
          ...raw.tools?.browser
        },
        system: {
          ...DEFAULT_CONFIG.tools.system,
          ...raw.tools?.system
        },
        file: {
          ...DEFAULT_CONFIG.tools.file,
          ...raw.tools?.file
        }
      },
      modelRouting: {
        chat: {
          ...DEFAULT_CONFIG.modelRouting.chat,
          ...raw.modelRouting?.chat
        },
        perception: {
          ...DEFAULT_CONFIG.modelRouting.perception,
          ...raw.modelRouting?.perception
        },
        memory: {
          ...DEFAULT_CONFIG.modelRouting.memory,
          ...raw.modelRouting?.memory
        }
      }
    };

    merged.voice = {
      ...merged.voice,
      requestTimeoutMs: clampInt(
        merged.voice?.requestTimeoutMs,
        3000,
        30000,
        DEFAULT_CONFIG.voice.requestTimeoutMs
      ),
      retryCount: clampInt(
        merged.voice?.retryCount,
        0,
        2,
        DEFAULT_CONFIG.voice.retryCount
      )
    };
    merged.alibabaVoice = {
      ...merged.alibabaVoice,
      apiKey: normalizeString(merged.alibabaVoice?.apiKey, ""),
      region: merged.alibabaVoice?.region === "intl" ? "intl" : "cn",
      asrModel: normalizeString(merged.alibabaVoice?.asrModel, DEFAULT_CONFIG.alibabaVoice.asrModel),
      ttsModel: normalizeString(merged.alibabaVoice?.ttsModel, DEFAULT_CONFIG.alibabaVoice.ttsModel),
      ttsVoice: normalizeString(merged.alibabaVoice?.ttsVoice, DEFAULT_CONFIG.alibabaVoice.ttsVoice)
    };
    merged.ptt = {
      ...merged.ptt,
      hotkey: normalizeHotkey(merged.ptt?.hotkey, DEFAULT_CONFIG.ptt.hotkey)
    };

    merged.tools = {
      browser: {
        ...merged.tools.browser,
        allowedDomains: normalizeStringList(merged.tools.browser.allowedDomains)
      },
      system: {
        ...merged.tools.system,
        allowedCommands: normalizeStringList(merged.tools.system.allowedCommands),
        blockedPatterns: normalizeStringList(merged.tools.system.blockedPatterns)
      },
      file: {
        ...merged.tools.file,
        allowedPaths: normalizeStringList(merged.tools.file.allowedPaths)
      }
    };

    this.cached = appConfigSchema.parse(merged);
    await writeJsonFile(this.paths.configPath, this.cached);
  }

  getConfig(): AppConfig {
    return this.cached;
  }

  async saveConfig(nextConfig: AppConfig): Promise<AppConfig> {
    const normalized = {
      ...nextConfig,
      voice: {
        ...nextConfig.voice,
        requestTimeoutMs: clampInt(
          nextConfig.voice.requestTimeoutMs,
          3000,
          30000,
          DEFAULT_CONFIG.voice.requestTimeoutMs
        ),
        retryCount: clampInt(nextConfig.voice.retryCount, 0, 2, DEFAULT_CONFIG.voice.retryCount)
      },
      alibabaVoice: {
        ...nextConfig.alibabaVoice,
        apiKey: normalizeString(nextConfig.alibabaVoice.apiKey, ""),
        region: nextConfig.alibabaVoice.region === "intl" ? "intl" : "cn",
        asrModel: normalizeString(nextConfig.alibabaVoice.asrModel, DEFAULT_CONFIG.alibabaVoice.asrModel),
        ttsModel: normalizeString(nextConfig.alibabaVoice.ttsModel, DEFAULT_CONFIG.alibabaVoice.ttsModel),
        ttsVoice: normalizeString(nextConfig.alibabaVoice.ttsVoice, DEFAULT_CONFIG.alibabaVoice.ttsVoice)
      },
      ptt: {
        ...nextConfig.ptt,
        hotkey: normalizeHotkey(nextConfig.ptt.hotkey, DEFAULT_CONFIG.ptt.hotkey)
      },
      tools: {
        browser: {
          ...nextConfig.tools.browser,
          allowedDomains: normalizeStringList(nextConfig.tools.browser.allowedDomains)
        },
        system: {
          ...nextConfig.tools.system,
          allowedCommands: normalizeStringList(nextConfig.tools.system.allowedCommands),
          blockedPatterns: normalizeStringList(nextConfig.tools.system.blockedPatterns)
        },
        file: {
          ...nextConfig.tools.file,
          allowedPaths: normalizeStringList(nextConfig.tools.file.allowedPaths)
        }
      }
    };

    this.cached = appConfigSchema.parse(normalized);
    await writeJsonFile(this.paths.configPath, this.cached);
    return this.cached;
  }
}
