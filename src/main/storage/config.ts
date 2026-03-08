import { appConfigSchema, DEFAULT_CONFIG, type AppConfig } from "@shared/types";
import { CompanionPaths } from "./paths";
import { appLogger as logger } from "@main/runtime/singletons";
import { fileExists, readJsonFile, writeJsonFile } from "./fs";

type McpServerList = AppConfig["tools"]["mcp"]["servers"];

const EXA_LOCKED_SERVER: Extract<McpServerList[number], { transport: "remote" }> = {
  id: "exa",
  label: "Exa Search",
  enabled: true,
  transport: "remote",
  url: "https://mcp.exa.ai/mcp",
  headers: {}
};

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

function ensureLockedExaServer(servers: McpServerList): McpServerList {
  const others = cloneMcpServers(servers).filter((server) => server.id !== EXA_LOCKED_SERVER.id);
  return [
    {
      ...EXA_LOCKED_SERVER,
      headers: {
        ...EXA_LOCKED_SERVER.headers
      }
    },
    ...others
  ];
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

  return mergeWithDefaults(DEFAULT_CONFIG, migratedRaw);
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
    return {
      ...config,
      tools: {
        ...config.tools,
        mcp: {
          ...config.tools.mcp,
          servers: ensureLockedExaServer(config.tools.mcp.servers)
        }
      }
    };
  }
}
