import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import type {
  SkillCatalogItem,
  SkillCompatibility,
  SkillResourceEntry
} from "@shared/types";
import { fileExists, readJsonFile, readTextFile, writeJsonFileAtomic } from "@main/storage/fs";
import type { CompanionPaths } from "@main/storage/paths";
import {
  buildSkillsCatalogPrompt,
  type SkillsCatalogBuildResult
} from "./catalog";
import {
  groupResources,
  normalizeSkillId,
  parseSkillCatalogItem,
  trimPreview
} from "./parser";

const execFileAsync = promisify(execFile);

interface PersistedSkillRecord extends Omit<SkillCatalogItem, "markdownPreview"> {}

interface SkillsRegistryFile {
  version: 1;
  updatedAt: string;
  skills: PersistedSkillRecord[];
}

const DEFAULT_REGISTRY: SkillsRegistryFile = {
  version: 1,
  updatedAt: new Date(0).toISOString(),
  skills: []
};

export class SkillManager {
  private cache = new Map<string, PersistedSkillRecord>();

  constructor(private readonly paths: CompanionPaths) {}

  async init(): Promise<void> {
    this.paths.ensureLayout();
    await this.loadRegistry();
    await this.rescan();
  }

  async listSkills(): Promise<SkillCatalogItem[]> {
    const items = this.getCachedSkills();
    const previews = await Promise.all(
      items.map(async (item) => ({
        id: item.id,
        preview: await this.readMarkdownPreview(item.markdownPath)
      }))
    );
    const previewMap = new Map(previews.map((item) => [item.id, item.preview]));

    return items.map((item) => ({
      ...item,
      markdownPreview: previewMap.get(item.id) ?? null
    }));
  }

  getCatalogPrompt(budgetTokens = 10_000): SkillsCatalogBuildResult {
    return buildSkillsCatalogPrompt(
      this.getCachedSkills().map((item) => ({
        ...item,
        markdownPreview: null
      })),
      budgetTokens
    );
  }

  async rescan(): Promise<SkillCatalogItem[]> {
    await mkdir(this.paths.skillsDir, { recursive: true });

    const entries = await readdir(this.paths.skillsDir, { withFileTypes: true });
    const previous = this.cache;
    const next = new Map<string, PersistedSkillRecord>();

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const directoryPath = path.join(this.paths.skillsDir, entry.name);
      const markdownPath = await resolveSkillMarkdownPath(directoryPath);
      if (!markdownPath) {
        continue;
      }

      const id = normalizeSkillId(entry.name);
      const markdownHead = await readHead(markdownPath, 32 * 1024);
      const resourceEntries = await indexSkillResources(directoryPath);
      const parsed = parseSkillCatalogItem({
        id,
        directoryPath,
        markdownPath,
        markdownHead,
        resourceEntries
      });
      const previousItem = previous.get(id);

      next.set(id, {
        ...parsed,
        enabled: previousItem?.enabled ?? true
      });
    }

    this.cache = next;
    await this.persistRegistry();
    return this.listSkills();
  }

  async setSkillEnabled(skillId: string, enabled: boolean): Promise<SkillCatalogItem> {
    const item = this.cache.get(skillId);
    if (!item) {
      throw new Error(`未找到 skill: ${skillId}`);
    }

    this.cache.set(skillId, {
      ...item,
      enabled
    });
    await this.persistRegistry();

    const updated = this.cache.get(skillId)!;
    return {
      ...updated,
      markdownPreview: await this.readMarkdownPreview(updated.markdownPath)
    };
  }

  async deleteSkill(skillId: string): Promise<{ removed: boolean; skillId: string }> {
    const item = this.cache.get(skillId);
    if (!item) {
      throw new Error(`未找到 skill: ${skillId}`);
    }

    await rm(item.directoryPath, {
      recursive: true,
      force: true
    });

    this.cache.delete(skillId);
    await this.persistRegistry();

    return {
      removed: true,
      skillId
    };
  }

  async importSkillDirectory(sourceDir: string): Promise<SkillCatalogItem> {
    const resolvedSourceDir = path.resolve(sourceDir);
    const sourceStats = await stat(resolvedSourceDir).catch(() => null);
    if (!sourceStats || !sourceStats.isDirectory()) {
      throw new Error("请选择包含 SKILL.md 的文件夹。");
    }

    const sourceMarkdownPath = await resolveSkillMarkdownPath(resolvedSourceDir);
    if (!sourceMarkdownPath) {
      throw new Error("所选目录内未找到 SKILL.md 或 skill.md。");
    }

    const baseSlug = normalizeSkillId(path.basename(resolvedSourceDir));
    let targetDir = path.join(this.paths.skillsDir, baseSlug);
    let suffix = 2;
    while (await fileExists(targetDir)) {
      targetDir = path.join(this.paths.skillsDir, `${baseSlug}-${suffix}`);
      suffix += 1;
    }

    await cp(resolvedSourceDir, targetDir, {
      recursive: true,
      force: true
    });

    const items = await this.rescan();
    const imported = items.find((item) => item.directoryPath === targetDir);
    if (!imported) {
      throw new Error("skill 导入后未能重新识别。");
    }

    return imported;
  }

  async activateSkill(skillId: string): Promise<{
    skillId: string;
    name: string;
    description: string;
    markdown: string;
    resources: Record<string, string[]>;
    compatibility: SkillCompatibility;
  }> {
    const item = this.getEnabledSkill(skillId);
    const markdown = await readTextFile(item.markdownPath, "");
    if (!markdown.trim()) {
      throw new Error(`skill 内容为空: ${skillId}`);
    }

    return {
      skillId: item.id,
      name: item.name,
      description: item.description,
      markdown,
      resources: groupResources(item.resourceEntries),
      compatibility: item.compatibility
    };
  }

  async listSkillResources(skillId: string): Promise<Record<string, string[]>> {
    const item = this.getEnabledSkill(skillId);
    return groupResources(item.resourceEntries);
  }

  async readSkillResource(skillId: string, relativePath: string): Promise<{
    skillId: string;
    relativePath: string;
    content: string;
  }> {
    const item = this.getEnabledSkill(skillId);
    const normalized = normalizeRelativePath(relativePath);
    const resource = item.resourceEntries.find((entry) => entry.relativePath === normalized);
    if (!resource) {
      throw new Error(`资源未索引或路径不合法: ${relativePath}`);
    }

    const absolutePath = path.join(item.directoryPath, normalized);
    const buffer = await readFile(absolutePath);
    if (!isTextBuffer(buffer)) {
      throw new Error(`资源不是可读取的文本文件: ${normalized}`);
    }

    const content = buffer.toString("utf8");
    return {
      skillId: item.id,
      relativePath: normalized,
      content: content.length <= 16_000 ? content : `${content.slice(0, 16_000)}\n...[truncated]`
    };
  }

  async runSkillScript(skillId: string, relativePath: string, args: string[]): Promise<{
    command: string;
    args: string[];
    cwd: string;
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    const item = this.getEnabledSkill(skillId);
    const normalized = normalizeRelativePath(relativePath);
    const resource = item.resourceEntries.find((entry) => entry.relativePath === normalized && entry.kind === "script");
    if (!resource) {
      throw new Error(`脚本未索引或路径不合法: ${relativePath}`);
    }

    const absolutePath = path.join(item.directoryPath, normalized);
    const interpreter = detectInterpreter(absolutePath);
    if (!interpreter) {
      throw new Error(`不支持的脚本类型: ${normalized}`);
    }

    try {
      const result = await execFileAsync(interpreter.command, [absolutePath, ...args], {
        cwd: item.directoryPath,
        timeout: 15_000,
        maxBuffer: 1_000_000
      });

      return {
        command: interpreter.command,
        args: [absolutePath, ...args],
        cwd: item.directoryPath,
        stdout: trimExecOutput(result.stdout ?? ""),
        stderr: trimExecOutput(result.stderr ?? ""),
        exitCode: 0
      };
    } catch (error: any) {
      return {
        command: interpreter.command,
        args: [absolutePath, ...args],
        cwd: item.directoryPath,
        stdout: trimExecOutput(typeof error?.stdout === "string" ? error.stdout : ""),
        stderr: trimExecOutput(
          typeof error?.stderr === "string"
            ? error.stderr
            : error instanceof Error
              ? error.message
              : String(error)
        ),
        exitCode: typeof error?.code === "number" ? error.code : 1
      };
    }
  }

  private getEnabledSkill(skillId: string): PersistedSkillRecord {
    const item = this.cache.get(skillId);
    if (!item) {
      throw new Error(`未找到 skill: ${skillId}`);
    }
    if (!item.enabled) {
      throw new Error(`skill 未启用: ${skillId}`);
    }
    if (item.compatibility.status === "invalid") {
      throw new Error(`skill 当前不可用: ${skillId}`);
    }
    return item;
  }

  private async loadRegistry(): Promise<void> {
    const registry = await readJsonFile<SkillsRegistryFile>(this.paths.skillsRegistryPath, DEFAULT_REGISTRY);
    this.cache = new Map((registry.skills ?? []).map((item) => [item.id, item]));
  }

  private async persistRegistry(): Promise<void> {
    await writeJsonFileAtomic<SkillsRegistryFile>(this.paths.skillsRegistryPath, {
      version: 1,
      updatedAt: new Date().toISOString(),
      skills: this.getCachedSkills()
    });
  }

  private getCachedSkills(): PersistedSkillRecord[] {
    return [...this.cache.values()].sort(
      (left, right) => left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id, "zh-CN")
    );
  }

  private async readMarkdownPreview(markdownPath: string): Promise<string | null> {
    const previewHead = await readHead(markdownPath, 4096);
    const preview = trimPreview(previewHead, 1200);
    return preview || null;
  }
}

async function resolveSkillMarkdownPath(directoryPath: string): Promise<string | null> {
  const upper = path.join(directoryPath, "SKILL.md");
  if (await fileExists(upper)) {
    return upper;
  }

  const lower = path.join(directoryPath, "skill.md");
  return (await fileExists(lower)) ? lower : null;
}

async function indexSkillResources(directoryPath: string): Promise<SkillResourceEntry[]> {
  const entries: SkillResourceEntry[] = [];

  for (const [dirName, kind] of [
    ["scripts", "script"],
    ["references", "reference"],
    ["assets", "asset"],
    ["templates", "template"]
  ] as const) {
    const root = path.join(directoryPath, dirName);
    if (!(await fileExists(root))) {
      continue;
    }

    const files = await walkFiles(root, directoryPath);
    for (const relativePath of files) {
      entries.push({
        kind,
        relativePath
      });
    }
  }

  return entries;
}

async function walkFiles(rootDir: string, skillDir: string): Promise<string[]> {
  const stack = [rootDir];
  const files: string[] = [];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }

      files.push(toPosix(path.relative(skillDir, absolute)));
    }
  }

  return files.sort((left, right) => left.localeCompare(right, "zh-CN"));
}

async function readHead(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function normalizeRelativePath(relativePath: string): string {
  const normalized = toPosix(path.posix.normalize(relativePath.trim().replace(/\\/g, "/"))).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || path.isAbsolute(normalized)) {
    throw new Error(`非法 relativePath: ${relativePath}`);
  }
  return normalized;
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function isTextBuffer(buffer: Buffer): boolean {
  return !buffer.subarray(0, Math.min(buffer.length, 2048)).includes(0);
}

function detectInterpreter(filePath: string): { command: string } | null {
  const contents = readFileSync(filePath, "utf8");
  const firstLine = contents.split(/\r?\n/, 1)[0] ?? "";
  if (firstLine.startsWith("#!")) {
    const shebang = firstLine.slice(2).trim();
    const parts = shebang.split(/\s+/).filter(Boolean);
    if (parts[0]?.endsWith("env") && parts[1]) {
      return { command: parts[1] };
    }
    if (parts[0]) {
      return { command: path.basename(parts[0]) };
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".sh") {
    return { command: "sh" };
  }
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    return { command: "node" };
  }
  if (ext === ".py") {
    return { command: "python3" };
  }

  return null;
}

function trimExecOutput(output: string, limit = 10_000): string {
  if (output.length <= limit) {
    return output;
  }
  return `${output.slice(0, limit)}\n...[truncated]`;
}
