import { homedir } from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import { promisify } from "node:util";
import { app } from "electron";
import yaml from "js-yaml";
import type { ChildProcess } from "node:child_process";
import type { AppConfig, ProviderConfig } from "@shared/types";

const execFileAsync = promisify(execFile);

function resolveOpenClawBin(): string {
  // 1. 打包内嵌优先
  if (app.isPackaged) {
    const base = path.join(process.resourcesPath, "openclaw-runtime", "node_modules", ".bin");
    const bin =
      process.platform === "win32"
        ? path.join(base, "openclaw.cmd")
        : path.join(base, "openclaw");
    if (existsSync(bin)) return bin;
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

export class OpenClawRuntime {
  private gatewayProcess: ChildProcess | null = null;
  private online = false;
  private message = "idle";

  constructor(private readonly onStatusChange?: (status: OpenClawStatus) => void) {}

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

    try {
      this.setStatus(false, "checking");
      const installed = await this.isInstalled();
      if (!installed) {
        this.setStatus(false, "not-installed");
        return;
      }

      this.setStatus(false, "syncing-llm");
      await this.injectLlmConfig(config);
      this.setStatus(false, "starting-gateway");
      await this.startGateway(config);
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
      await execFileAsync(resolveOpenClawBin(), ["--version"], { env: resolveEnv() });
      return true;
    } catch {
      return false;
    }
  }

  private async startGateway(config: AppConfig): Promise<void> {
    if (this.gatewayProcess && !this.gatewayProcess.killed) {
      return;
    }

    const url = new URL(config.openclaw.gatewayUrl);
    const port = Number(url.port || "18789");
    const host = url.hostname || "127.0.0.1";

    const child = spawn(
      resolveOpenClawBin(),
      ["gateway", "--host", host, "--port", String(port)],
      {
        stdio: "ignore",
        env: resolveEnv()
      }
    );
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

    child.once("exit", () => {
      if (this.gatewayProcess === child) {
        this.gatewayProcess = null;
      }
      this.setStatus(false, "gateway-exited");
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 600));

    if (startState.spawnError) {
      throw new Error(`OpenClaw gateway 启动失败: ${startState.spawnError.message}`);
    }

    if (this.gatewayProcess !== child || child.killed || child.exitCode !== null) {
      throw new Error("OpenClaw gateway 启动失败");
    }
  }

  private async injectLlmConfig(config: AppConfig): Promise<void> {
    const route = config.modelRouting.chat;
    const provider = config.providers.find((item) => item.id === route.providerId);
    if (!provider) {
      throw new Error(`OpenClaw LLM sync failed: missing provider ${route.providerId}`);
    }

    const openclawConfigPath = path.join(homedir(), ".openclaw", "config.yaml");
    const dir = path.dirname(openclawConfigPath);
    await fs.mkdir(dir, {
      recursive: true
    });

    let existing: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(openclawConfigPath, "utf8");
      const parsed = yaml.load(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      existing = {};
    }

    const llmSection = this.buildLlmSection(provider, route.model);
    const merged: Record<string, unknown> = {
      ...existing,
      llm: llmSection
    };

    const encoded = yaml.dump(merged, {
      noRefs: true,
      lineWidth: 120
    });
    await fs.writeFile(openclawConfigPath, encoded, "utf8");
  }

  private buildLlmSection(provider: ProviderConfig, model: string): Record<string, unknown> {
    const section: Record<string, unknown> = {
      provider: provider.kind,
      model,
      api_key: provider.apiKey
    };

    if (provider.kind === "custom-openai" && provider.baseUrl) {
      section.base_url = provider.baseUrl;
    }

    if (provider.kind === "openrouter") {
      section.base_url = "https://openrouter.ai/api/v1";
    }

    return section;
  }

  private setStatus(online: boolean, message: string): void {
    this.online = online;
    this.message = message;
    this.onStatusChange?.({
      online,
      message
    });
  }
}
