import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { app } from "electron";
import type { ChildProcess } from "node:child_process";
import type { AppConfig, ProviderConfig } from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import { isRecord } from "@main/utils/guards";

const execFileAsync = promisify(execFile);
const GATEWAY_HEALTH_WAIT_TIMEOUT_MS = 15_000;
const GATEWAY_HEALTH_RETRY_INTERVAL_MS = 350;
const GATEWAY_HEALTH_CHECK_TIMEOUT_MS = 1_500;
const OPENCLAW_CUSTOM_OPENAI_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) OpenClaw/2026.2.14";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  fallbackModelRefs: string[];
  gatewayToken: string;
  sessionModelProvider: string;
  sessionModelId: string;
  providerConfigs: Record<string, Record<string, unknown>>;
  managed: {
    thinkingDefault: AppConfig["openclaw"]["thinkingDefault"];
    contextTokens: number;
    timeoutSeconds: number;
    browserEnabled: boolean;
    browserProfile: AppConfig["openclaw"]["browserProfile"];
    browserHeadless: boolean;
    browserExecutablePath: string;
    heartbeatEvery: string;
    toolWebSearchEnabled: boolean;
    toolWebFetchEnabled: boolean;
    toolExecSecurity: "deny" | "full";
    toolElevatedEnabled: boolean;
    maxConcurrent: number;
    sandboxMode: AppConfig["openclaw"]["sandboxMode"];
  };
}

interface OpenClawSyncState {
  fingerprint: string;
  updatedAt: string;
}

export class OpenClawRuntime {
  private gatewayProcess: ChildProcess | null = null;
  private online = false;
  private message = "idle";
  private gatewayAuthToken = "";

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

  getGatewayAuthToken(): string {
    return this.gatewayAuthToken;
  }

  async getDashboardUrl(): Promise<string> {
    const { stdout, stderr } = await execFileAsync(resolveOpenClawBin(), ["dashboard", "--no-open"], {
      env: this.resolveBaseEnv()
    });
    const output = `${stdout}\n${stderr}`;
    const matched = output.match(/Dashboard URL:\s*(\S+)/i);
    if (!matched?.[1]) {
      throw new Error("无法获取 OpenClaw Dashboard URL");
    }

    return matched[1].trim();
  }

  async start(config: AppConfig): Promise<void> {
    if (!config.openclaw.enabled) {
      this.gatewayAuthToken = "";
      await this.stop("disabled");
      return;
    }

    if (this.gatewayProcess && !this.gatewayProcess.killed) {
      await this.stop("restarting");
    }

    try {
      this.gatewayAuthToken = this.generateGatewayToken();
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
      this.setStatus(false, "waiting-gateway-health");
      await this.waitForGatewayHealthy(config);
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

  private async waitForGatewayHealthy(config: AppConfig): Promise<void> {
    const deadline = Date.now() + GATEWAY_HEALTH_WAIT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const healthy = await this.checkGatewayHealth(config);
      if (healthy) {
        return;
      }

      await sleep(GATEWAY_HEALTH_RETRY_INTERVAL_MS);
    }

    throw new Error("gateway-health-timeout");
  }

  private async checkGatewayHealth(config: AppConfig): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, GATEWAY_HEALTH_CHECK_TIMEOUT_MS);

    try {
      const url = new URL("/health", config.openclaw.gatewayUrl).toString();
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private buildBootstrap(config: AppConfig): GatewayBootstrap {
    const route = config.modelRouting.chat;
    const primaryTarget = config.openclaw.modelPrimary.trim()
      ? this.parseConfiguredModelInput(config.openclaw.modelPrimary.trim(), route.providerId)
      : {
          providerId: route.providerId,
          modelId: route.model.trim()
        };

    const fallbackTargets = config.openclaw.modelFallbacks
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => this.parseConfiguredModelInput(item, primaryTarget.providerId));

    const providerById = new Map(config.providers.map((item) => [item.id, item]));
    const primaryProvider = providerById.get(primaryTarget.providerId);
    if (!primaryProvider) {
      throw new Error(`OpenClaw config failed: missing provider ${primaryTarget.providerId}`);
    }

    const env = this.resolveBaseEnv();
    env.OPENCLAW_STATE_DIR = this.paths.openclawStateDir;
    env.OPENCLAW_CONFIG_PATH = this.paths.openclawConfigPath;

    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
    delete env.OPENROUTER_API_KEY;

    const customModelsByProvider = new Map<string, Set<string>>();
    const customProviderById = new Map<string, ProviderConfig>();

    const resolveTargetModelRef = (target: {
      providerId: string;
      modelId: string;
    }): string => {
      const provider = providerById.get(target.providerId);
      if (!provider) {
        throw new Error(`OpenClaw config failed: missing provider ${target.providerId}`);
      }

      const customProviderId =
        provider.kind === "custom-openai" ? this.resolveCustomProviderId(provider.id) : undefined;
      const resolvedModelRef = this.resolveModelRef(provider, target.modelId, customProviderId);

      if (customProviderId) {
        customProviderById.set(customProviderId, provider);
        const set = customModelsByProvider.get(customProviderId) ?? new Set<string>();
        set.add(this.splitModelRef(resolvedModelRef).modelId);
        customModelsByProvider.set(customProviderId, set);
      }

      return resolvedModelRef;
    };

    const modelRef = resolveTargetModelRef(primaryTarget);
    const fallbackModelRefs = Array.from(
      new Set(fallbackTargets.map((target) => resolveTargetModelRef(target)).filter((item) => item !== modelRef))
    );
    const routing = this.splitModelRef(modelRef);

    const providerConfigs: Record<string, Record<string, unknown>> = {};

    const resolvePreferredProviderKey = (
      kind: "anthropic" | "openai" | "openrouter"
    ): string | undefined => {
      const preferred = primaryProvider.kind === kind ? primaryProvider : undefined;
      const candidate =
        preferred && preferred.apiKey.trim()
          ? preferred
          : config.providers.find((item) => item.kind === kind && item.enabled && item.apiKey.trim()) ??
            config.providers.find((item) => item.kind === kind && item.apiKey.trim());

      const key = candidate?.apiKey.trim();
      return key || undefined;
    };

    const anthropicApiKey = resolvePreferredProviderKey("anthropic");
    if (anthropicApiKey) {
      env.ANTHROPIC_API_KEY = anthropicApiKey;
    }

    const openaiApiKey = resolvePreferredProviderKey("openai");
    if (openaiApiKey) {
      env.OPENAI_API_KEY = openaiApiKey;
    }

    const openrouterApiKey = resolvePreferredProviderKey("openrouter");
    if (openrouterApiKey) {
      env.OPENROUTER_API_KEY = openrouterApiKey;
    }

    for (const [customProviderId, modelIds] of customModelsByProvider.entries()) {
      const provider = customProviderById.get(customProviderId);
      if (!provider) {
        continue;
      }

      providerConfigs[customProviderId] = this.buildCustomProviderConfig(
        provider,
        Array.from(modelIds.values()),
        customProviderId
      );
    }

    const bootstrap: GatewayBootstrap = {
      env,
      modelRef,
      fallbackModelRefs,
      gatewayToken: this.gatewayAuthToken,
      sessionModelProvider: routing.providerId,
      sessionModelId: routing.modelId,
      providerConfigs,
      managed: {
        thinkingDefault: config.openclaw.thinkingDefault,
        contextTokens: config.openclaw.contextTokens,
        timeoutSeconds: config.openclaw.timeoutSeconds,
        browserEnabled: config.openclaw.browserEnabled,
        browserProfile: config.openclaw.browserProfile,
        browserHeadless: config.openclaw.browserHeadless,
        browserExecutablePath: config.openclaw.browserExecutablePath.trim(),
        heartbeatEvery: config.openclaw.heartbeatEvery.trim() || "30m",
        toolWebSearchEnabled: config.openclaw.toolWebSearchEnabled,
        toolWebFetchEnabled: config.openclaw.toolWebFetchEnabled,
        toolExecSecurity: config.openclaw.toolExecEnabled ? "full" : "deny",
        toolElevatedEnabled: config.openclaw.toolElevatedEnabled,
        maxConcurrent: config.openclaw.maxConcurrent,
        sandboxMode: config.openclaw.sandboxMode
      }
    };

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
      await this.syncMainAgentState(bootstrap);
      return;
    }

    const existing = await this.readOpenClawConfig();
    const nextConfig = this.buildManagedOpenClawConfig(existing, bootstrap);
    await fs.writeFile(this.paths.openclawConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

    await this.syncMainAgentState(bootstrap);

    await this.writeSyncState({
      fingerprint,
      updatedAt: new Date().toISOString()
    });
  }

  private async syncMainAgentState(bootstrap: GatewayBootstrap): Promise<void> {
    await this.syncMainAgentModelsFile(bootstrap);
    await this.syncMainSessionRouting(bootstrap);
  }

  private async readOpenClawConfig(): Promise<Record<string, unknown>> {
    let parsed: unknown;
    try {
      const raw = await fs.readFile(this.paths.openclawConfigPath, "utf8");
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }

    if (!isRecord(parsed)) {
      return {};
    }

    return this.cloneRecord(parsed);
  }

  private buildManagedOpenClawConfig(
    existing: Record<string, unknown>,
    bootstrap: GatewayBootstrap
  ): Record<string, unknown> {
    const next = this.cloneRecord(existing);
    delete next.hooks;

    this.setConfigPath(next, ["gateway", "auth", "mode"], "token");
    this.setConfigPath(next, ["gateway", "auth", "token"], bootstrap.gatewayToken);
    this.setConfigPath(next, ["gateway", "http", "endpoints", "responses", "enabled"], true);

    this.setConfigPath(next, ["agents", "defaults", "model", "primary"], bootstrap.modelRef);
    this.setConfigPath(next, ["agents", "defaults", "model", "fallbacks"], bootstrap.fallbackModelRefs);
    this.setConfigPath(
      next,
      ["agents", "defaults", "thinkingDefault"],
      bootstrap.managed.thinkingDefault
    );
    this.setConfigPath(next, ["agents", "defaults", "contextTokens"], bootstrap.managed.contextTokens);
    this.setConfigPath(next, ["agents", "defaults", "timeoutSeconds"], bootstrap.managed.timeoutSeconds);
    this.setConfigPath(next, ["agents", "defaults", "maxConcurrent"], bootstrap.managed.maxConcurrent);
    this.setConfigPath(next, ["agents", "defaults", "sandbox", "mode"], bootstrap.managed.sandboxMode);
    this.setConfigPath(next, ["agents", "defaults", "heartbeat", "every"], bootstrap.managed.heartbeatEvery);

    this.setConfigPath(next, ["browser", "enabled"], bootstrap.managed.browserEnabled);
    this.setConfigPath(next, ["browser", "defaultProfile"], bootstrap.managed.browserProfile);
    this.setConfigPath(next, ["browser", "headless"], bootstrap.managed.browserHeadless);
    if (bootstrap.managed.browserExecutablePath) {
      this.setConfigPath(
        next,
        ["browser", "executablePath"],
        bootstrap.managed.browserExecutablePath
      );
    } else {
      this.deleteConfigPath(next, ["browser", "executablePath"]);
    }

    this.setConfigPath(next, ["tools", "web", "search", "enabled"], bootstrap.managed.toolWebSearchEnabled);
    this.setConfigPath(next, ["tools", "web", "fetch", "enabled"], bootstrap.managed.toolWebFetchEnabled);
    this.setConfigPath(next, ["tools", "exec", "security"], bootstrap.managed.toolExecSecurity);
    this.setConfigPath(next, ["tools", "elevated", "enabled"], bootstrap.managed.toolElevatedEnabled);

    this.setConfigPath(next, ["models", "mode"], "merge");
    this.setConfigPath(next, ["models", "providers"], bootstrap.providerConfigs);

    return next;
  }

  private setConfigPath(root: Record<string, unknown>, pathParts: string[], value: unknown): void {
    let cursor: Record<string, unknown> = root;

    for (let index = 0; index < pathParts.length - 1; index += 1) {
      const part = pathParts[index];
      const current = cursor[part];
      if (!isRecord(current)) {
        const next: Record<string, unknown> = {};
        cursor[part] = next;
        cursor = next;
        continue;
      }

      cursor = current;
    }

    cursor[pathParts[pathParts.length - 1]] = value;
  }

  private deleteConfigPath(root: Record<string, unknown>, pathParts: string[]): void {
    if (pathParts.length === 0) {
      return;
    }

    let cursor: Record<string, unknown> = root;
    for (let index = 0; index < pathParts.length - 1; index += 1) {
      const current = cursor[pathParts[index]];
      if (!isRecord(current)) {
        return;
      }

      cursor = current;
    }

    delete cursor[pathParts[pathParts.length - 1]];
  }

  private cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
    try {
      return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    } catch {
      return {
        ...value
      };
    }
  }

  private async syncMainAgentModelsFile(bootstrap: GatewayBootstrap): Promise<void> {
    const agentDir = path.join(this.paths.openclawStateDir, "agents", "main", "agent");
    const modelsPath = path.join(agentDir, "models.json");

    await fs.mkdir(agentDir, {
      recursive: true
    });

    const modelsPayload = {
      providers: bootstrap.providerConfigs
    };

    await fs.writeFile(modelsPath, `${JSON.stringify(modelsPayload, null, 2)}\n`, "utf8");
  }

  private async syncMainSessionRouting(bootstrap: GatewayBootstrap): Promise<void> {
    const providerId = bootstrap.sessionModelProvider.trim();
    const model = bootstrap.sessionModelId.trim();
    if (!providerId || !model) {
      return;
    }

    const sessionsPath = path.join(
      this.paths.openclawStateDir,
      "agents",
      "main",
      "sessions",
      "sessions.json"
    );

    let parsed: unknown;
    try {
      const raw = await fs.readFile(sessionsPath, "utf8");
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (!isRecord(parsed)) {
      return;
    }

    let changed = false;

    for (const [key, entry] of Object.entries(parsed)) {
      if (!isRecord(entry)) {
        continue;
      }

      if (!key.startsWith("agent:main:")) {
        continue;
      }

      if (entry.modelProvider !== providerId) {
        entry.modelProvider = providerId;
        changed = true;
      }

      if (entry.model !== model) {
        entry.model = model;
        changed = true;
      }
    }

    if (!changed) {
      return;
    }

    await fs.writeFile(sessionsPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  }

  private splitModelRef(modelRef: string): {
    providerId: string;
    modelId: string;
  } {
    const normalized = modelRef.trim();
    const slashIndex = normalized.indexOf("/");
    if (slashIndex <= 0 || slashIndex >= normalized.length - 1) {
      throw new Error(`OpenClaw config failed: invalid model ref ${normalized || "<empty>"}`);
    }

    return {
      providerId: normalized.slice(0, slashIndex),
      modelId: normalized.slice(slashIndex + 1)
    };
  }

  private parseConfiguredModelInput(
    modelRef: string,
    fallbackProviderId: string
  ): {
    providerId: string;
    modelId: string;
  } {
    const normalized = modelRef.trim();
    if (!normalized) {
      throw new Error("OpenClaw config failed: model ref is empty");
    }

    if (!normalized.includes("/")) {
      const providerId = fallbackProviderId.trim();
      if (!providerId) {
        throw new Error(`OpenClaw config failed: invalid model ref ${normalized}`);
      }

      return {
        providerId,
        modelId: normalized
      };
    }

    return this.splitModelRef(normalized);
  }

  private resolveModelRef(
    provider: ProviderConfig,
    model: string,
    customProviderId?: string
  ): string {
    const normalizedModel = model.trim();
    if (!normalizedModel) {
      throw new Error("OpenClaw config failed: model is empty");
    }

    if (provider.kind === "custom-openai") {
      if (!customProviderId) {
        throw new Error("OpenClaw config failed: custom provider id missing");
      }

      const customModelId = this.normalizeCustomModelId(normalizedModel, customProviderId);
      return this.withProviderPrefix(customModelId, customProviderId);
    }

    return this.withProviderPrefix(normalizedModel, provider.kind);
  }

  private buildCustomProviderConfig(
    provider: ProviderConfig,
    models: string[],
    customProviderId: string
  ): Record<string, unknown> {
    const normalizedModels = Array.from(
      new Set(
        models
          .map((model) => this.normalizeCustomModelId(model.trim(), customProviderId))
          .filter(Boolean)
      )
    );
    if (normalizedModels.length === 0) {
      throw new Error(`OpenClaw config failed: custom provider ${customProviderId} has no models`);
    }

    const apiMode = provider.apiMode === "responses" ? "openai-responses" : "openai-completions";
    const config: Record<string, unknown> = {
      baseUrl: this.normalizeCustomOpenAIBaseUrl(provider.baseUrl),
      api: apiMode,
      auth: "api-key",
      authHeader: true,
      apiKey: provider.apiKey,
      headers: {
        "User-Agent": OPENCLAW_CUSTOM_OPENAI_USER_AGENT,
        Accept: "application/json"
      },
      models: normalizedModels.map((modelId) => ({
        id: modelId,
        name: modelId
      }))
    };

    if (!provider.apiKey.trim()) {
      delete config.apiKey;
    }

    return config;
  }

  private normalizeCustomModelId(model: string, customProviderId: string): string {
    const providerPrefix = `${customProviderId.toLowerCase()}/`;
    if (model.toLowerCase().startsWith(providerPrefix)) {
      return model.slice(customProviderId.length + 1);
    }

    return model;
  }

  private resolveCustomProviderId(providerId: string): string {
    const normalized = providerId.trim();
    if (!normalized) {
      throw new Error("OpenClaw config failed: custom-openai provider id is empty");
    }

    if (normalized.includes("/")) {
      throw new Error("OpenClaw config failed: custom-openai provider id cannot contain '/'");
    }

    return normalized;
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

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
    }

    const pathname = parsed.pathname.trim();
    if (pathname === "" || pathname === "/") {
      parsed.pathname = "/v1";
      return parsed.toString().replace(/\/$/, "");
    }

    return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  }

  private resolveBaseEnv(): NodeJS.ProcessEnv {
    const env = resolveEnv();
    env.OPENCLAW_STATE_DIR = this.paths.openclawStateDir;
    env.OPENCLAW_CONFIG_PATH = this.paths.openclawConfigPath;
    return env;
  }

  private buildSyncFingerprint(bootstrap: GatewayBootstrap): string {
    return JSON.stringify({
      gateway: {
        authMode: "token",
        authToken: bootstrap.gatewayToken,
        responsesEnabled: true
      },
      providerSyncVersion: 4,
      modelRef: bootstrap.modelRef,
      fallbackModelRefs: bootstrap.fallbackModelRefs,
      providerConfigs: bootstrap.providerConfigs,
      managed: bootstrap.managed
    });
  }

  private generateGatewayToken(): string {
    return `yobi-${randomUUID().replace(/-/g, "")}`;
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
