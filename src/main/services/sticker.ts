import { promises as fs } from "node:fs";
import path from "node:path";

export type StickerAsset =
  | {
      type: "url";
      value: string;
    }
  | {
      type: "file";
      value: string;
    };

function randomPick<T>(list: T[]): T | null {
  if (list.length === 0) {
    return null;
  }
  return list[Math.floor(Math.random() * list.length)] ?? null;
}

function collectUrls(input: unknown): string[] {
  const urls: string[] = [];

  const visit = (value: unknown): void => {
    if (!value) {
      return;
    }

    if (typeof value === "string") {
      if (/^https?:\/\//i.test(value)) {
        urls.push(value);
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const key of ["url", "image", "imageUrl", "src"]) {
        const candidate = record[key];
        if (typeof candidate === "string" && /^https?:\/\//i.test(candidate)) {
          urls.push(candidate);
        }
      }

      for (const nested of Object.values(record)) {
        visit(nested);
      }
    }
  };

  visit(input);
  return Array.from(new Set(urls));
}

async function walkFiles(dirPath: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await walkFiles(fullPath);
      results.push(...nested);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) {
      results.push(fullPath);
    }
  }

  return results;
}

export class StickerService {
  async findSticker(input: {
    keyword: string;
    endpoint: string;
    timeoutMs: number;
    offlineDir: string;
  }): Promise<StickerAsset | null> {
    const fromEndpoint = await this.searchFromEndpoint(input.keyword, input.endpoint, input.timeoutMs);
    if (fromEndpoint) {
      return {
        type: "url",
        value: fromEndpoint
      };
    }

    const fromLocal = await this.searchLocal(input.keyword, input.offlineDir);
    if (fromLocal) {
      return {
        type: "file",
        value: fromLocal
      };
    }

    return null;
  }

  private async searchFromEndpoint(
    keyword: string,
    endpoint: string,
    timeoutMs: number
  ): Promise<string | null> {
    const trimmed = endpoint.trim();
    if (!trimmed) {
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const url = new URL(trimmed);
      url.searchParams.set("keyword", keyword);

      const response = await fetch(url.toString(), {
        method: "GET",
        signal: controller.signal,
        headers: {
          Accept: "application/json,text/plain;q=0.8,*/*;q=0.6"
        }
      });

      if (!response.ok) {
        return null;
      }

      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }

      const urls = collectUrls(parsed);
      const picked = randomPick(urls);
      return picked;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async searchLocal(keyword: string, offlineDir: string): Promise<string | null> {
    const dir = offlineDir.trim();
    if (!dir) {
      return null;
    }

    const allFiles = await walkFiles(dir);
    if (allFiles.length === 0) {
      return null;
    }

    const normalizedKeyword = keyword.trim().toLowerCase();
    const filtered = normalizedKeyword
      ? allFiles.filter((filePath) => filePath.toLowerCase().includes(normalizedKeyword))
      : allFiles;

    return randomPick(filtered) ?? randomPick(allFiles);
  }
}
