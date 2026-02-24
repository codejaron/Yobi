import { mkdir } from "node:fs/promises";
import { collectPageSnapshot, refSelector, type PageSnapshot } from "./snapshot";
import { getDefaultBrowserProfileDir } from "./profiles";

export interface BrowserConfig {
  headless: boolean;
  cdpPort: number;
  navigationTimeoutMs?: number;
}

export interface TabInfo {
  index: number;
  title: string;
  url: string;
  active: boolean;
}

export type BrowserAction =
  | {
      kind: "click";
      ref: number;
    }
  | {
      kind: "type";
      ref: number;
      text: string;
      append?: boolean;
    }
  | {
      kind: "press";
      key: string;
      ref?: number;
    }
  | {
      kind: "hover";
      ref: number;
    }
  | {
      kind: "select";
      ref: number;
      option: string;
    }
  | {
      kind: "scroll";
      deltaY?: number;
    };

interface BrowserModule {
  chromium: {
    launchPersistentContext: (profileDir: string, options: Record<string, unknown>) => Promise<any>;
  };
}

export class BrowserController {
  private browserContext: any | null = null;
  private currentPage: any | null = null;
  private browserModule: BrowserModule | null = null;

  async start(config: BrowserConfig): Promise<void> {
    if (this.browserContext) {
      return;
    }

    const profileDir = getDefaultBrowserProfileDir();
    await mkdir(profileDir, { recursive: true });

    const browser = await this.loadBrowserModule();
    this.browserContext = await browser.chromium.launchPersistentContext(profileDir, {
      headless: config.headless,
      viewport: {
        width: 1280,
        height: 800
      },
      acceptDownloads: true,
      args: [`--remote-debugging-port=${config.cdpPort}`]
    });

    this.currentPage = this.browserContext.pages()[0] ?? (await this.browserContext.newPage());
    const timeout = config.navigationTimeoutMs ?? 20_000;
    this.currentPage.setDefaultNavigationTimeout(timeout);
    this.currentPage.setDefaultTimeout(timeout);
  }

  async stop(): Promise<void> {
    if (this.browserContext) {
      await this.browserContext.close();
    }

    this.browserContext = null;
    this.currentPage = null;
  }

  async navigate(url: string): Promise<{ url: string; title: string }> {
    const page = await this.requirePage();
    await page.goto(url, {
      waitUntil: "domcontentloaded"
    });

    return {
      url: page.url(),
      title: await page.title()
    };
  }

  async snapshot(): Promise<PageSnapshot> {
    const page = await this.requirePage();
    return collectPageSnapshot(page);
  }

  async act(action: BrowserAction): Promise<{ message: string; url: string }> {
    const page = await this.requirePage();

    if (action.kind === "scroll") {
      await page.mouse.wheel(0, action.deltaY ?? 700);
      return {
        message: `已滚动 ${action.deltaY ?? 700}px`,
        url: page.url()
      };
    }

    if (action.kind === "press") {
      if (action.ref) {
        await page.locator(refSelector(action.ref)).first().focus();
      }
      await page.keyboard.press(action.key);
      return {
        message: `已按下按键 ${action.key}`,
        url: page.url()
      };
    }

    const locator = page.locator(refSelector(action.ref)).first();

    if (action.kind === "click") {
      await locator.click();
      return {
        message: `已点击元素 #${action.ref}`,
        url: page.url()
      };
    }

    if (action.kind === "hover") {
      await locator.hover();
      return {
        message: `已悬停元素 #${action.ref}`,
        url: page.url()
      };
    }

    if (action.kind === "type") {
      await locator.click();
      if (action.append) {
        await page.keyboard.type(action.text);
      } else {
        await locator.fill(action.text);
      }

      return {
        message: `已输入文本到元素 #${action.ref}`,
        url: page.url()
      };
    }

    await locator.selectOption([
      {
        label: action.option
      },
      {
        value: action.option
      }
    ]);

    return {
      message: `已选择选项 ${action.option}`,
      url: page.url()
    };
  }

  async screenshot(options?: { fullPage?: boolean }): Promise<Buffer> {
    const page = await this.requirePage();
    return page.screenshot({
      type: "png",
      fullPage: options?.fullPage ?? false
    });
  }

  async tabs(): Promise<TabInfo[]> {
    const context = await this.requireContext();
    const pages = context.pages();
    const active = await this.requirePage();

    const items: TabInfo[] = [];
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      items.push({
        index,
        title: await page.title(),
        url: page.url(),
        active: page === active
      });
    }

    return items;
  }

  async open(url?: string): Promise<{ index: number; url: string; title: string }> {
    const context = await this.requireContext();
    const page = await context.newPage();
    this.currentPage = page;

    if (url) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }

    const pages = context.pages();
    return {
      index: pages.findIndex((item: any) => item === page),
      url: page.url(),
      title: await page.title()
    };
  }

  async close(index?: number): Promise<{ remaining: number }> {
    const context = await this.requireContext();
    const pages = context.pages();

    const target =
      typeof index === "number" && index >= 0 && index < pages.length
        ? pages[index]
        : this.currentPage ?? pages[0];

    if (!target) {
      return {
        remaining: 0
      };
    }

    await target.close();

    const remainingPages = context.pages();
    this.currentPage = remainingPages.at(-1) ?? null;

    return {
      remaining: remainingPages.length
    };
  }

  private async requireContext(): Promise<any> {
    if (!this.browserContext) {
      throw new Error("浏览器尚未启动，请先调用 browser.start。");
    }

    return this.browserContext;
  }

  private async requirePage(): Promise<any> {
    const context = await this.requireContext();

    if (this.currentPage && !this.currentPage.isClosed()) {
      return this.currentPage;
    }

    this.currentPage = context.pages()[0] ?? (await context.newPage());
    return this.currentPage;
  }

  private async loadBrowserModule(): Promise<BrowserModule> {
    if (this.browserModule) {
      return this.browserModule;
    }

    const packageName = "playwright";

    let mod: unknown;
    try {
      mod = await import(packageName);
    } catch {
      throw new Error(
        "未检测到 playwright 依赖，请先在项目中安装：npm install playwright"
      );
    }

    const resolved = mod as BrowserModule;
    if (!resolved.chromium?.launchPersistentContext) {
      throw new Error("playwright.chromium 不可用，无法启动浏览器控制器。");
    }

    this.browserModule = resolved;
    return resolved;
  }
}
