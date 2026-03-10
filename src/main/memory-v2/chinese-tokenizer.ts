const STOP_WORDS = new Set([
  "的",
  "了",
  "吗",
  "呢",
  "啊",
  "呀",
  "哦",
  "我",
  "你",
  "他",
  "她",
  "它",
  "我们",
  "你们",
  "他们",
  "是",
  "在",
  "有",
  "和",
  "就",
  "都",
  "也",
  "要",
  "想",
  "会",
  "不",
  "没"
]);

interface JiebaModule {
  cut(text: string, hmm?: boolean): string[];
  cut_for_search(text: string, hmm?: boolean): string[];
}

function hasLetterOrNumber(value: string): boolean {
  return /[\p{L}\p{N}\u3400-\u9fff]/u.test(value);
}

function normalizeToken(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function filterToken(raw: string): string | null {
  const token = normalizeToken(raw);
  if (!token) {
    return null;
  }
  if (!hasLetterOrNumber(token)) {
    return null;
  }
  if (STOP_WORDS.has(token)) {
    return null;
  }
  if (/^[A-Za-z]$/.test(token)) {
    return null;
  }
  return token;
}

export class ChineseTokenizerService {
  private module: JiebaModule | null = null;
  private initPromise: Promise<void> | null = null;

  async init(): Promise<void> {
    if (this.module) {
      return;
    }
    if (!this.initPromise) {
      this.initPromise = this.loadModule();
    }
    await this.initPromise;
  }

  async tokenizeForIndex(text: string, limit = 64): Promise<string[]> {
    await this.init();
    return this.normalizeTokens(this.module?.cut_for_search(text, true) ?? [], limit);
  }

  async tokenizeForQuery(text: string, limit = 12): Promise<string[]> {
    await this.init();
    return this.normalizeTokens(this.module?.cut(text, true) ?? [], limit);
  }

  buildMatchQuery(tokens: string[]): string {
    const filtered = tokens.map((token) => token.replace(/"/g, '""')).filter(Boolean);
    if (filtered.length === 0) {
      return "";
    }
    return filtered.map((token) => `"${token}"`).join(" OR ");
  }

  private async loadModule(): Promise<void> {
    const jieba = await import("jieba-wasm");
    this.module = {
      cut: jieba.cut,
      cut_for_search: jieba.cut_for_search
    };
    this.module.cut("初始化分词", true);
    this.module.cut_for_search("初始化分词", true);
  }

  private normalizeTokens(tokens: string[], limit: number): string[] {
    const deduped = new Set<string>();
    const output: string[] = [];
    for (const raw of tokens) {
      const token = filterToken(raw);
      if (!token || deduped.has(token)) {
        continue;
      }
      deduped.add(token);
      output.push(token);
      if (output.length >= Math.max(1, limit)) {
        break;
      }
    }
    return output;
  }
}
