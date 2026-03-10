import { appConfigSchema, DEFAULT_CONFIG, type AppConfig } from "@shared/types";
import { CompanionPaths } from "./paths";
import { appLogger as logger } from "@main/runtime/singletons";
import { fileExists, readJsonFile, writeJsonFile } from "./fs";

type McpServerList = AppConfig["tools"]["mcp"]["servers"];

function normalizeVoiceProviders(config: AppConfig): AppConfig {
  const asrProvider = config.voice.asrProvider;
  const ttsProvider = config.voice.ttsProvider;

  return {
    ...config,
    voice: {
      ...config.voice,
      asrProvider,
      ttsProvider
    },
    whisperLocal: {
      ...config.whisperLocal,
      enabled: asrProvider === "whisper-local"
    },
    alibabaVoice: {
      ...config.alibabaVoice,
      enabled: asrProvider === "alibaba" || ttsProvider === "alibaba"
    }
  };
}

function cloneMcpServers(servers: McpServerList): McpServerList {
  return servers.map((server) =>
    server.transport === "stdio"
      ? {
          ...server,
          args: [...server.args],
          env: {
            ...server.env
          }
        }
      : {
          ...server,
          headers: {
            ...server.headers
          }
        }
  );
}

function filterInternalMcpServers(servers: McpServerList): McpServerList {
  return cloneMcpServers(servers).filter((server) => server.id !== "exa");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as T;
  }

  if (!isPlainRecord(value)) {
    return value;
  }

  const cloned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    cloned[key] = deepClone(child);
  }
  return cloned as T;
}

function mergeWithDefaults<T>(defaults: T, value: unknown): T {
  if (Array.isArray(defaults)) {
    if (!Array.isArray(value)) {
      return deepClone(defaults);
    }
    return deepClone(value) as T;
  }

  if (isPlainRecord(defaults)) {
    const source = isPlainRecord(value) ? value : {};
    const merged: Record<string, unknown> = {};

    for (const [key, defaultChild] of Object.entries(defaults)) {
      merged[key] = mergeWithDefaults(defaultChild, source[key]);
    }

    return merged as T;
  }

  if (value === undefined) {
    return deepClone(defaults);
  }

  return value as T;
}

function migrateRawConfig(raw: unknown): unknown {
  if (!isPlainRecord(raw)) {
    return mergeWithDefaults(DEFAULT_CONFIG, raw);
  }

  const migratedRaw = deepClone(raw) as Record<string, unknown>;
  const telegram = migratedRaw.telegram;
  if (isPlainRecord(telegram) && typeof telegram.enabled !== "boolean") {
    const token = typeof telegram.botToken === "string" ? telegram.botToken.trim() : "";
    telegram.enabled = token.length > 0;
  }

  const qq = migratedRaw.qq;
  if (isPlainRecord(qq)) {
    const hasAppSecret = typeof qq.appSecret === "string" && qq.appSecret.trim().length > 0;
    const legacyClientSecret = typeof qq.clientSecret === "string" ? qq.clientSecret : "";
    if (!hasAppSecret && legacyClientSecret.trim().length > 0) {
      qq.appSecret = legacyClientSecret;
    }
  }

  const feishu = migratedRaw.feishu;
  if (isPlainRecord(feishu) && typeof feishu.enabled !== "boolean") {
    const appId = typeof feishu.appId === "string" ? feishu.appId.trim() : "";
    const appSecret = typeof feishu.appSecret === "string" ? feishu.appSecret.trim() : "";
    feishu.enabled = appId.length > 0 && appSecret.length > 0;
  }

  const proactive = migratedRaw.proactive;
  if (isPlainRecord(proactive) && !isPlainRecord(proactive.pushTargets)) {
    const localOnly = typeof proactive.localOnly === "boolean" ? proactive.localOnly : true;
    proactive.pushTargets = {
      telegram: !localOnly,
      feishu: !localOnly
    };
  }

  const voice = isPlainRecord(migratedRaw.voice) ? voiceOrDefault(migratedRaw.voice) : {};
  const whisperLocal = isPlainRecord(migratedRaw.whisperLocal) ? migratedRaw.whisperLocal : {};
  const alibabaVoice = isPlainRecord(migratedRaw.alibabaVoice) ? migratedRaw.alibabaVoice : {};
  const legacyRuntimeConfig = isPlainRecord(migratedRaw.openclaw) ? migratedRaw.openclaw : null;
  const tools = isPlainRecord(migratedRaw.tools) ? migratedRaw.tools : {};
  const toolMcp = isPlainRecord(tools.mcp) ? tools.mcp : {};
  const mcpServers = Array.isArray(toolMcp.servers) ? toolMcp.servers : [];

  const legacyExaServer = mcpServers.find((server) => isPlainRecord(server) && server.id === "exa");
  const legacyExaEnabled =
    legacyExaServer && typeof legacyExaServer.enabled === "boolean" ? legacyExaServer.enabled : undefined;

  if (legacyRuntimeConfig && isPlainRecord(migratedRaw.memory) && isPlainRecord(migratedRaw.memory.context)) {
    const legacyContextTokens = Number(legacyRuntimeConfig.contextTokens);
    if (Number.isFinite(legacyContextTokens) && migratedRaw.memory.context.maxPromptTokens === undefined) {
      migratedRaw.memory.context.maxPromptTokens = Math.max(4_000, Math.min(24_000, Math.floor(legacyContextTokens)));
    }
  }

  if (!isPlainRecord(tools.browser)) {
    tools.browser = {
      ...DEFAULT_CONFIG.tools.browser
    };
  }

  if (!isPlainRecord(tools.system)) {
    tools.system = {
      ...DEFAULT_CONFIG.tools.system
    };
  }

  if (!isPlainRecord(tools.file)) {
    tools.file = {
      ...DEFAULT_CONFIG.tools.file
    };
  }

  if (!isPlainRecord(tools.exa)) {
    tools.exa = {
      enabled: typeof legacyExaEnabled === "boolean" ? legacyExaEnabled : DEFAULT_CONFIG.tools.exa.enabled
    };
  } else if (typeof tools.exa.enabled !== "boolean" && typeof legacyExaEnabled === "boolean") {
    tools.exa.enabled = legacyExaEnabled;
  }

  if (isPlainRecord(tools.mcp)) {
    tools.mcp = {
      ...tools.mcp,
      servers: mcpServers.filter((server) => !(isPlainRecord(server) && server.id === "exa"))
    };
  }

  migratedRaw.tools = tools;
  delete migratedRaw.openclaw;

  if (typeof voice.asrProvider !== "string") {
    if (whisperLocal.enabled === true) {
      voice.asrProvider = "whisper-local";
    } else if (alibabaVoice.enabled === true) {
      voice.asrProvider = "alibaba";
    } else {
      voice.asrProvider = "none";
    }
  }

  if (typeof voice.ttsProvider !== "string") {
    voice.ttsProvider = alibabaVoice.enabled === true ? "alibaba" : "edge";
  }

  migratedRaw.voice = voice;
  return mergeWithDefaults(DEFAULT_CONFIG, migratedRaw);
}

function voiceOrDefault(value: Record<string, unknown>): Record<string, unknown> {
  return {
    ...value
  };
}

function assertRouteProvidersExist(config: AppConfig): void {
  const providerIds = new Set(config.providers.map((provider) => provider.id));
  const routes: Array<keyof AppConfig["modelRouting"]> = ["chat", "factExtraction", "reflection"];
  for (const routeKey of routes) {
    const route = config.modelRouting[routeKey];
    if (!route) {
      throw new Error(`Missing model route config: ${routeKey}`);
    }
    if (!providerIds.has(route.providerId)) {
      throw new Error(`Missing provider for ${routeKey} route: ${route.providerId}`);
    }
  }
}

export class ConfigStore {
  private cached: AppConfig = DEFAULT_CONFIG;

  constructor(private readonly paths: CompanionPaths) {}

  async init(): Promise<void> {
    this.paths.ensureLayout();

    const exists = await fileExists(this.paths.configPath);
    if (!exists) {
      this.cached = this.prepareConfig(DEFAULT_CONFIG);
      await writeJsonFile(this.paths.configPath, this.cached);
      return;
    }

    const raw = await readJsonFile<unknown>(this.paths.configPath, null);
    const migrated = migrateRawConfig(raw);
    const parsed = appConfigSchema.safeParse(migrated);
    if (parsed.success) {
      const prepared = this.prepareConfig(parsed.data);
      try {
        assertRouteProvidersExist(prepared);
      } catch (error) {
        logger.warn("config", "route-provider-validation-failed", undefined, error);
      }
      this.cached = prepared;
      await writeJsonFile(this.paths.configPath, this.cached);
      return;
    }

    this.cached = this.prepareConfig(DEFAULT_CONFIG);
    await writeJsonFile(this.paths.configPath, this.cached);
  }

  getConfig(): AppConfig {
    return this.cached;
  }

  async saveConfig(nextConfig: AppConfig): Promise<AppConfig> {
    const parsed = appConfigSchema.parse(nextConfig);
    const prepared = this.prepareConfig(parsed);
    assertRouteProvidersExist(prepared);
    this.cached = prepared;
    await writeJsonFile(this.paths.configPath, this.cached);
    return this.cached;
  }

  private prepareConfig(config: AppConfig): AppConfig {
    const normalized = normalizeVoiceProviders(config);

    return {
      ...normalized,
      tools: {
        ...normalized.tools,
        mcp: {
          ...normalized.tools.mcp,
          servers: filterInternalMcpServers(normalized.tools.mcp.servers)
        }
      }
    };
  }
}
