import { appConfigSchema, DEFAULT_CONFIG, type AppConfig } from "@shared/types";
import { CompanionPaths } from "./paths";
import { fileExists, readJsonFile, writeJsonFile } from "./fs";

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
    this.cached = appConfigSchema.parse({
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
      stickers: {
        ...DEFAULT_CONFIG.stickers,
        ...raw.stickers
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
    });

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
    this.cached = appConfigSchema.parse(nextConfig);
    await writeJsonFile(this.paths.configPath, this.cached);
    return this.cached;
  }
}
