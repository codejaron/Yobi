import { homedir } from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { app } from "electron";
import type { ChildProcess } from "node:child_process";
import type { AppConfig, ProviderConfig } from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import { OPENCLAW_HOOK_PATH, OPENCLAW_HOOK_TOKEN } from "./constants";

const execFileAsync = promisify(execFile);
const CUSTOM_PROVIDER_ID = "yobi";

function resolveOpenClawBin(): string {
  // 1. 打包内嵌优先
  if (app.isPackaged) {
    const base = path.join(process.resourcesPath, "openclaw-runtime", "node_modules", ".bin");
    return process.platform === "win32"
      ? path.join(base, "openclaw.cmd")
      : path.join(base, "openclaw");
  }

  // 2. 回退到系统 PATH
  return "openclaw";
}

function resolveEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  // 打包环境：内嵌 bin 目录加到 PATH 最前
  if (app.isPackaged) {
    const binDir = path.join(process.resourcesPath, "openclaw-runtime", "node_modules", ".bin");
    env.PATH = `${binDir}${path.delimiter}${env.PATH ?? ""}`;
  }

  // 开发环境：补全常见全局路径（解决 Electron GUI 启动 PATH 缺失）
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", `${homedir()}/.npm-global/bin`];
  const current = env.PATH ?? "";
  for (const p of extra) {
    if (!current.includes(p)) {
      env.PATH = `${p}${path.delimiter}${env.PATH}`;
    }
  }

  return env;
}

interface OpenClawStatus {
  online: boolean;
  message: string;
}

interface GatewayBootstrap {
  env: NodeJS.ProcessEnv;
  modelRef: string;
  customProviderConfig?: Record<string, unknown>;
}

interface OpenClawSyncState {
  fingerprint: string;
  updatedAt: string;
}

export class OpenClawRuntime {
  private gatewayProcess: ChildProcess | null = null;
  private online = false;
  private message = "idle";

  constructor(
    private readonly paths: CompanionPaths,
    private readonly onStatusChange?: (status: OpenClawStatus) => void
  ) {}

  getStatus(): OpenClawStatus {
    return {
      online: this.online,
      message: this.message
    };
  }

  async start(config: AppConfig): Promise<void> {
    if (!config.openclaw.enabled) {
      await this.stop("disabled");
      return;
    }

    if (this.gatewayProcess && !this.gatewayProcess.killed) {
      await this.stop("restarting");
    }

    try {
      this.setStatus(false, "checking");
      const installed = await this.isInstalled();
      if (!installed) {
        this.setStatus(false, "not-installed");
        return;
      }

      this.setStatus(false, "checking-config");
      const bootstrap = this.buildBootstrap(config);
      await this.syncOpenClawConfig(bootstrap);
      this.setStatus(false, "starting-gateway");
      await this.startGateway(config, bootstrap.env);
      this.setStatus(true, "online");
    } catch (error) {
      this.setStatus(false, error instanceof Error ? error.message : "startup-failed");
    }
  }

  async stop(reason = "stopped"): Promise<void> {
    if (!this.gatewayProcess) {
      this.setStatus(false, reason);
      return;
    }

    this.gatewayProcess.kill("SIGTERM");
    this.gatewayProcess = null;
    this.setStatus(false, reason);
  }

  private async isInstalled(): Promise<boolean> {
    try {
      await execFileAsync(resolveOpenClawBin(), ["--version"], {
        env: this.resolveBaseEnv()
      });
      return true;
    } catch {
      return false;
    }
  }

  private async startGateway(config: AppConfig, env: NodeJS.ProcessEnv): Promise<void> {
    if (this.gatewayProcess && !this.gatewayProcess.killed) {
      return;
    }

    const url = new URL(config.openclaw.gatewayUrl);
    const port = Number(url.port || "18789");
    const host = url.hostname || "127.0.0.1";
    const bindMode = this.resolveBindMode(host);
    const args = ["gateway", "run", "--allow-unconfigured", "--bind", bindMode, "--port", String(port)];

    const child = spawn(resolveOpenClawBin(), args, {
      stdio: "ignore",
      env
    });
    this.gatewayProcess = child;

    const startState: {
      spawnError?: Error;
    } = {};

    child.on("error", (error) => {
      startState.spawnError = error as Error;
      if (this.gatewayProcess === child) {
        this.gatewayProcess = null;
      }
      this.setStatus(false, `gateway-error: ${error.message}`);
    });

    child.once("exit", (code, signal) => {
      if (this.gatewayProcess === child) {
        this.gatewayProcess = null;
      }
      if (signal) {
        this.setStatus(false, `gateway-exited:signal-${signal}`);
        return;
      }
      this.setStatus(false, `gateway-exited:code-${code ?? "unknown"}`);
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 600));

    if (startState.spawnError) {
      throw new Error(`OpenClaw gateway 启动失败: ${startState.spawnError.message}`);
    }

    if (this.gatewayProcess !== child || child.killed || child.exitCode !== null) {
      throw new Error("OpenClaw gateway 启动失败");
    }
  }

  private buildBootstrap(config: AppConfig): GatewayBootstrap {
    const route = config.modelRouting.chat;
    const provider = config.providers.find((item) => item.id === route.providerId);
    if (!provider) {
      throw new Error(`OpenClaw config failed: missing provider ${route.providerId}`);
    }

    const env = this.resolveBaseEnv();
    env.OPENCLAW_STATE_DIR = this.paths.openclawStateDir;
    env.OPENCLAW_CONFIG_PATH = this.paths.openclawConfigPath;

    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
    delete env.OPENROUTER_API_KEY;

    const modelRef = this.resolveModelRef(provider, route.model);
    const bootstrap: GatewayBootstrap = {
      env,
      modelRef
    };

    if (provider.kind === "anthropic" && provider.apiKey.trim()) {
      env.ANTHROPIC_API_KEY = provider.apiKey.trim();
    } else if (provider.kind === "openai" && provider.apiKey.trim()) {
      env.OPENAI_API_KEY = provider.apiKey.trim();
    } else if (provider.kind === "openrouter" && provider.apiKey.trim()) {
      env.OPENROUTER_API_KEY = provider.apiKey.trim();
    } else if (provider.kind === "custom-openai") {
      bootstrap.customProviderConfig = this.buildCustomProviderConfig(provider, route.model);
    }

    return bootstrap;
  }

  private async syncOpenClawConfig(bootstrap: GatewayBootstrap): Promise<void> {
    await fs.mkdir(this.paths.openclawStateDir, {
      recursive: true
    });

    const fingerprint = this.buildSyncFingerprint(bootstrap);
    const [configExists, syncState] = await Promise.all([
      this.pathExists(this.paths.openclawConfigPath),
      this.readSyncState()
    ]);

    if (configExists && syncState?.fingerprint === fingerprint) {
      return;
    }

    await this.runConfigSet("hooks.enabled", true, bootstrap.env);
    await this.runConfigSet("hooks.path", OPENCLAW_HOOK_PATH, bootstrap.env);
    await this.runConfigSet("hooks.token", OPENCLAW_HOOK_TOKEN, bootstrap.env);
    await this.runConfigSet("agents.defaults.model.primary", bootstrap.modelRef, bootstrap.env);

    if (bootstrap.customProviderConfig) {
      await this.runConfigSet("models.mode", "merge", bootstrap.env);
      await this.runConfigSet(
        `models.providers.${CUSTOM_PROVIDER_ID}`,
        bootstrap.customProviderConfig,
        bootstrap.env
      );
    }

    await this.writeSyncState({
      fingerprint,
      updatedAt: new Date().toISOString()
    });
  }

  private async runConfigSet(pathName: string, value: unknown, env: NodeJS.ProcessEnv): Promise<void> {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string") {
      throw new Error(`OpenClaw config failed: value for ${pathName} is not serializable`);
    }

    try {
      await execFileAsync(resolveOpenClawBin(), ["config", "set", pathName, encoded, "--strict-json"], {
        env
      });
    } catch (error) {
      throw new Error(`OpenClaw config set ${pathName} failed: ${this.formatExecError(error)}`);
    }
  }

  private resolveModelRef(provider: ProviderConfig, model: string): string {
    const normalizedModel = model.trim();
    if (!normalizedModel) {
      throw new Error("OpenClaw config failed: model is empty");
    }

    if (provider.kind === "custom-openai") {
      const customModelId = this.normalizeCustomModelId(normalizedModel);
      return this.withProviderPrefix(customModelId, CUSTOM_PROVIDER_ID);
    }

    return this.withProviderPrefix(normalizedModel, provider.kind);
  }

  private buildCustomProviderConfig(provider: ProviderConfig, model: string): Record<string, unknown> {
    const normalizedModel = this.normalizeCustomModelId(model.trim());
    const apiMode = provider.apiMode === "responses" ? "openai-responses" : "openai-completions";
    const config: Record<string, unknown> = {
      baseUrl: this.normalizeCustomOpenAIBaseUrl(provider.baseUrl),
      api: apiMode,
      apiKey: provider.apiKey,
      models: [
        {
          id: normalizedModel,
          name: normalizedModel
        }
      ]
    };

    if (!provider.apiKey.trim()) {
      delete config.apiKey;
    }

    return config;
  }

  private normalizeCustomModelId(model: string): string {
    const prefix = `${CUSTOM_PROVIDER_ID.toLowerCase()}/`;
    if (model.toLowerCase().startsWith(prefix)) {
      return model.slice(CUSTOM_PROVIDER_ID.length + 1);
    }
    return model;
  }

  private withProviderPrefix(model: string, providerId: string): string {
    const lowerPrefix = `${providerId.toLowerCase()}/`;
    if (model.toLowerCase().startsWith(lowerPrefix)) {
      return model;
    }

    return `${providerId}/${model}`;
  }

  private normalizeCustomOpenAIBaseUrl(baseUrl?: string): string {
    const trimmed = (baseUrl ?? "").trim();
    if (!trimmed) {
      throw new Error("OpenClaw config failed: custom-openai provider requires baseUrl");
    }
    return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  }

  private formatExecError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  private resolveBaseEnv(): NodeJS.ProcessEnv {
    const env = resolveEnv();
    env.OPENCLAW_STATE_DIR = this.paths.openclawStateDir;
    env.OPENCLAW_CONFIG_PATH = this.paths.openclawConfigPath;
    return env;
  }

  private buildSyncFingerprint(bootstrap: GatewayBootstrap): string {
    return JSON.stringify({
      hooks: {
        enabled: true,
        path: OPENCLAW_HOOK_PATH,
        token: OPENCLAW_HOOK_TOKEN
      },
      modelRef: bootstrap.modelRef,
      customProviderConfig: bootstrap.customProviderConfig ?? null
    });
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private async readSyncState(): Promise<OpenClawSyncState | null> {
    try {
      const raw = await fs.readFile(this.paths.openclawSyncStatePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        return null;
      }

      const fingerprint =
        "fingerprint" in parsed && typeof parsed.fingerprint === "string" ? parsed.fingerprint : "";
      const updatedAt =
        "updatedAt" in parsed && typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
      if (!fingerprint || !updatedAt) {
        return null;
      }

      return {
        fingerprint,
        updatedAt
      };
    } catch {
      return null;
    }
  }

  private async writeSyncState(state: OpenClawSyncState): Promise<void> {
    await fs.writeFile(this.paths.openclawSyncStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private setStatus(online: boolean, message: string): void {
    this.online = online;
    this.message = message;
    this.onStatusChange?.({
      online,
      message
    });
  }

  private resolveBindMode(host: string): "loopback" | "lan" | "auto" {
    const normalized = host.trim().toLowerCase();
    if (normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1") {
      return "loopback";
    }

    if (
      normalized === "0.0.0.0" ||
      normalized.startsWith("10.") ||
      normalized.startsWith("192.168.") ||
      normalized.startsWith("172.")
    ) {
      return "lan";
    }

    return "auto";
  }
}
