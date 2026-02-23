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
      background: {
        ...DEFAULT_CONFIG.background,
        ...raw.background
      },
      pet: {
        ...DEFAULT_CONFIG.pet,
        ...raw.pet
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
      proxy: normalizeString(merged.voice?.proxy, ""),
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

    this.cached = appConfigSchema.parse(merged);

    if (
      this.cached.pet.modelDir === "haru_greeter_pro_jp" ||
      this.cached.pet.modelDir === "resources/pets/haru_greeter_pro_jp"
    ) {
      this.cached = {
        ...this.cached,
        pet: {
          ...this.cached.pet,
          modelDir: "resources/models/haru_greeter_pro_jp"
        }
      };
    }
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
        proxy: normalizeString(nextConfig.voice.proxy, ""),
        requestTimeoutMs: clampInt(
          nextConfig.voice.requestTimeoutMs,
          3000,
          30000,
          DEFAULT_CONFIG.voice.requestTimeoutMs
        ),
        retryCount: clampInt(nextConfig.voice.retryCount, 0, 2, DEFAULT_CONFIG.voice.retryCount)
      }
    };

    this.cached = appConfigSchema.parse(normalized);
    await writeJsonFile(this.paths.configPath, this.cached);
    return this.cached;
  }
}
