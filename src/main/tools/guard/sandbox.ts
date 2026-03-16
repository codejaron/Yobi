import net from "node:net";
import path from "node:path";
import type { AppConfig } from "@shared/types";

function normalizeList(items: string[]): string[] {
  return items.map((item) => item.trim()).filter(Boolean);
}

function toLowerList(items: string[]): string[] {
  return normalizeList(items).map((item) => item.toLowerCase());
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();

  if (!host) {
    return true;
  }

  if (host === "localhost" || host === "::1" || host.endsWith(".local")) {
    return true;
  }

  const ipVersion = net.isIP(host);
  if (ipVersion === 0) {
    return false;
  }

  if (ipVersion === 4) {
    const [a, b] = host.split(".").map((part) => Number(part));
    if (a === 10 || a === 127 || a === 0) {
      return true;
    }
    if (a === 192 && b === 168) {
      return true;
    }
    if (a === 169 && b === 254) {
      return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }

    return false;
  }

  return host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80");
}

function firstToken(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return "";
  }

  const match = trimmed.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const token = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  return token;
}

function isInsideRoot(target: string, root: string): boolean {
  const normalizedTarget = path.resolve(target);
  const normalizedRoot = path.resolve(root);

  if (normalizedTarget === normalizedRoot) {
    return true;
  }

  return normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

export class SandboxGuard {
  constructor(
    private readonly getConfig: () => AppConfig,
    private readonly internalReadRoots: string[] = []
  ) {}

  ensureBrowserEnabled(): void {
    if (!this.getConfig().tools.browser.enabled) {
      throw new Error("浏览器工具未启用，请先在设置中开启。");
    }
  }

  ensureBrowserUrlAllowed(rawUrl: string): void {
    this.ensureBrowserEnabled();

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error(`无效 URL: ${rawUrl}`);
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`仅允许 http/https，当前协议: ${parsed.protocol}`);
    }

    const browserPolicy = this.getConfig().tools.browser;

    if (browserPolicy.blockPrivateNetwork && isPrivateHost(parsed.hostname)) {
      throw new Error(`策略阻止访问私有网络地址: ${parsed.hostname}`);
    }

    const allowedDomains = toLowerList(browserPolicy.allowedDomains);
    if (allowedDomains.length === 0) {
      return;
    }

    const host = parsed.hostname.toLowerCase();
    const matched = allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
    if (!matched) {
      throw new Error(`域名不在白名单内: ${host}`);
    }
  }

  ensureExecAllowed(command: string): void {
    const config = this.getConfig();
    if (!config.tools.system.enabled || !config.tools.system.execEnabled) {
      throw new Error("系统命令执行未启用，请先在设置中开启。");
    }

    const trimmed = command.trim();
    if (!trimmed) {
      throw new Error("命令不能为空。");
    }

    const lowerCommand = trimmed.toLowerCase();
    const blockedPatterns = toLowerList(config.tools.system.blockedPatterns);
    const blocked = blockedPatterns.find((pattern) => lowerCommand.includes(pattern));
    if (blocked) {
      throw new Error(`命令命中阻止规则: ${blocked}`);
    }

    const commandToken = firstToken(trimmed);
    if (!commandToken) {
      throw new Error("无法解析命令入口。");
    }

    const allowedCommands = normalizeList(config.tools.system.allowedCommands);
    if (allowedCommands.length === 0) {
      return;
    }

    const tokenBasename = path.basename(commandToken);
    const allowed = allowedCommands.some((candidate) => {
      const normalizedCandidate = candidate.trim();
      if (!normalizedCandidate) {
        return false;
      }

      if (commandToken === normalizedCandidate) {
        return true;
      }

      return tokenBasename === path.basename(normalizedCandidate);
    });

    if (!allowed) {
      throw new Error(`命令不在 allowlist 中: ${commandToken}`);
    }
  }

  ensureFileReadAllowed(targetPath: string): string {
    const config = this.getConfig();
    if (!config.tools.file.readEnabled) {
      throw new Error("文件读取能力未启用。");
    }

    return this.assertPathAllowed(targetPath, [...config.tools.file.allowedPaths, ...this.internalReadRoots]);
  }

  ensureFileWriteAllowed(targetPath: string): string {
    const config = this.getConfig();
    if (!config.tools.file.writeEnabled) {
      throw new Error("文件写入能力未启用。");
    }

    const resolved = this.assertPathAllowed(targetPath, config.tools.file.allowedPaths);
    const blockedInternalRoot = this.internalReadRoots.find((root) => isInsideRoot(resolved, root));
    if (blockedInternalRoot) {
      throw new Error(`路径是内部只读目录，禁止写入: ${resolved}`);
    }

    return resolved;
  }

  private assertPathAllowed(targetPath: string, allowedRoots: string[]): string {
    const resolved = path.resolve(targetPath);
    const roots = normalizeList(allowedRoots);

    if (roots.length === 0) {
      return resolved;
    }

    const matched = roots.some((root) => isInsideRoot(resolved, root));
    if (!matched) {
      throw new Error(`路径不在允许范围内: ${resolved}`);
    }

    return resolved;
  }
}
