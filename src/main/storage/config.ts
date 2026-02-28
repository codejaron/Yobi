import { appConfigSchema, DEFAULT_CONFIG, type AppConfig } from "@shared/types";
import { CompanionPaths } from "./paths";
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
    const parsed = appConfigSchema.safeParse(raw);
    if (!parsed.success) {
      this.cached = this.prepareConfig(appConfigSchema.parse({}));
      await writeJsonFile(this.paths.configPath, this.cached);
      return;
    }

    this.cached = this.prepareConfig(parsed.data);
  }

  getConfig(): AppConfig {
    return this.cached;
  }

  async saveConfig(nextConfig: AppConfig): Promise<AppConfig> {
    const parsed = appConfigSchema.parse(nextConfig);
    this.cached = this.prepareConfig(parsed);
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
