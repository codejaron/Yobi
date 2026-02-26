import { createRequire } from "node:module";

export type GlobalPttPhase = "down" | "up";

export interface GlobalPttStartInput {
  hotkey: string;
  onPhase: (phase: GlobalPttPhase) => void;
}

interface UiohookKeyboardEvent {
  keycode?: unknown;
  altKey?: unknown;
  ctrlKey?: unknown;
  shiftKey?: unknown;
  metaKey?: unknown;
}

interface UiohookLike {
  on: (eventName: "keydown" | "keyup", listener: (event: UiohookKeyboardEvent) => void) => void;
  removeListener?: (
    eventName: "keydown" | "keyup",
    listener: (event: UiohookKeyboardEvent) => void
  ) => void;
  off?: (eventName: "keydown" | "keyup", listener: (event: UiohookKeyboardEvent) => void) => void;
  removeAllListeners?: (eventName?: "keydown" | "keyup") => void;
  start: () => void;
  stop: () => void;
}

interface GlobalHotkeyConfig {
  keyCode: number;
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  signature: string;
}

const KEYCODE_MAP: Record<string, number> = {
  SPACE: 57,
  ENTER: 28,
  TAB: 15,
  ESC: 1,
  BACKSPACE: 14,
  "0": 11,
  "1": 2,
  "2": 3,
  "3": 4,
  "4": 5,
  "5": 6,
  "6": 7,
  "7": 8,
  "8": 9,
  "9": 10,
  A: 30,
  B: 48,
  C: 46,
  D: 32,
  E: 18,
  F: 33,
  G: 34,
  H: 35,
  I: 23,
  J: 36,
  K: 37,
  L: 38,
  M: 50,
  N: 49,
  O: 24,
  P: 25,
  Q: 16,
  R: 19,
  S: 31,
  T: 20,
  U: 22,
  V: 47,
  W: 17,
  X: 45,
  Y: 21,
  Z: 44,
  F1: 59,
  F2: 60,
  F3: 61,
  F4: 62,
  F5: 63,
  F6: 64,
  F7: 65,
  F8: 66,
  F9: 67,
  F10: 68,
  F11: 87,
  F12: 88
};

function normalizeHotkeyToken(token: string): string {
  const normalized = token.trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  if (normalized === "space" || normalized === "spacebar" || normalized === "空格") {
    return "SPACE";
  }

  if (normalized === "enter" || normalized === "return" || normalized === "回车") {
    return "ENTER";
  }

  if (normalized === "tab") {
    return "TAB";
  }

  if (normalized === "esc" || normalized === "escape") {
    return "ESC";
  }

  if (normalized === "backspace") {
    return "BACKSPACE";
  }

  if (/^[a-z]$/.test(normalized)) {
    return normalized.toUpperCase();
  }

  if (/^[0-9]$/.test(normalized)) {
    return normalized;
  }

  const fMatch = normalized.match(/^f([1-9]|1[0-2])$/);
  if (fMatch) {
    return `F${fMatch[1]}`;
  }

  return normalized.toUpperCase();
}

function parseHotkey(raw: string): GlobalHotkeyConfig {
  const tokens = raw
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length < 2) {
    throw new Error("快捷键格式无效，请使用例如 Alt+Space 的组合。");
  }

  let keyToken = "";
  let alt = false;
  let ctrl = false;
  let shift = false;
  let meta = false;

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (["alt", "option", "opt"].includes(lower)) {
      alt = true;
      continue;
    }
    if (["ctrl", "control", "ctl"].includes(lower)) {
      ctrl = true;
      continue;
    }
    if (["shift"].includes(lower)) {
      shift = true;
      continue;
    }
    if (["meta", "cmd", "command", "super", "win", "windows"].includes(lower)) {
      meta = true;
      continue;
    }

    if (keyToken) {
      throw new Error("快捷键只能包含一个主按键。");
    }

    keyToken = token;
  }

  if (!alt && !ctrl && !shift && !meta) {
    throw new Error("快捷键至少要包含一个修饰键（Ctrl/Alt/Shift/Meta）。");
  }

  if (!keyToken) {
    throw new Error("快捷键缺少主按键。");
  }

  const normalizedKey = normalizeHotkeyToken(keyToken);
  const keyCode = KEYCODE_MAP[normalizedKey];
  if (typeof keyCode !== "number") {
    throw new Error("暂不支持该主按键，请改用字母、数字、F1-F12 或 Space。");
  }

  const signature = `${ctrl ? 1 : 0}${alt ? 1 : 0}${shift ? 1 : 0}${meta ? 1 : 0}:${normalizedKey}`;

  return {
    keyCode,
    alt,
    ctrl,
    shift,
    meta,
    signature
  };
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function loadUiohook(): UiohookLike {
  const require = createRequire(import.meta.url);

  let moduleValue: unknown;
  try {
    moduleValue = require("uiohook-napi");
  } catch {
    throw new Error("未检测到 uiohook-napi，请先安装依赖后重启应用。");
  }

  const candidate =
    (moduleValue as { uIOhook?: unknown })?.uIOhook ??
    (moduleValue as { default?: { uIOhook?: unknown } })?.default?.uIOhook ??
    (moduleValue as { default?: unknown })?.default ??
    moduleValue;

  if (
    !candidate ||
    typeof (candidate as UiohookLike).on !== "function" ||
    typeof (candidate as UiohookLike).start !== "function" ||
    typeof (candidate as UiohookLike).stop !== "function"
  ) {
    throw new Error("uiohook-napi 初始化失败。");
  }

  return candidate as UiohookLike;
}

export class GlobalPetPushToTalkService {
  private hook: UiohookLike | null = null;
  private onPhase: ((phase: GlobalPttPhase) => void) | null = null;
  private currentHotkey: GlobalHotkeyConfig | null = null;
  private primaryKeyPressed = false;
  private comboActive = false;
  private readonly handleKeyDown = (event: UiohookKeyboardEvent) => {
    this.handleEvent(event, true);
  };
  private readonly handleKeyUp = (event: UiohookKeyboardEvent) => {
    this.handleEvent(event, false);
  };

  async start(input: GlobalPttStartInput): Promise<void> {
    this.onPhase = input.onPhase;

    const parsed = parseHotkey(input.hotkey);
    if (this.hook && this.currentHotkey?.signature === parsed.signature) {
      return;
    }

    this.stop();

    const hook = loadUiohook();
    hook.on("keydown", this.handleKeyDown);
    hook.on("keyup", this.handleKeyUp);
    hook.start();

    this.hook = hook;
    this.currentHotkey = parsed;
    this.primaryKeyPressed = false;
    this.comboActive = false;
  }

  stop(): void {
    if (this.comboActive) {
      this.comboActive = false;
      this.safeEmitPhase("up");
    }

    this.primaryKeyPressed = false;
    this.currentHotkey = null;

    if (!this.hook) {
      return;
    }

    const hook = this.hook;
    this.hook = null;
    try {
      if (typeof hook.off === "function") {
        hook.off("keydown", this.handleKeyDown);
        hook.off("keyup", this.handleKeyUp);
      } else if (typeof hook.removeListener === "function") {
        hook.removeListener("keydown", this.handleKeyDown);
        hook.removeListener("keyup", this.handleKeyUp);
      } else if (typeof hook.removeAllListeners === "function") {
        hook.removeAllListeners("keydown");
        hook.removeAllListeners("keyup");
      }
      hook.stop();
    } catch (error) {
      console.warn("[global-ptt] failed to stop uiohook:", error);
    }
  }

  isRunning(): boolean {
    return this.hook !== null;
  }

  private handleEvent(event: UiohookKeyboardEvent, isKeyDown: boolean): void {
    const hotkey = this.currentHotkey;
    if (!hotkey) {
      return;
    }

    const keycode = Number(event.keycode);
    if (!Number.isFinite(keycode)) {
      return;
    }

    if (keycode === hotkey.keyCode) {
      this.primaryKeyPressed = isKeyDown;
    }

    const active = this.primaryKeyPressed && this.matchesModifiers(event, hotkey);
    if (active === this.comboActive) {
      return;
    }

    this.comboActive = active;
    this.safeEmitPhase(active ? "down" : "up");
  }

  private matchesModifiers(event: UiohookKeyboardEvent, hotkey: GlobalHotkeyConfig): boolean {
    if (hotkey.alt && !asBoolean(event.altKey)) {
      return false;
    }

    if (hotkey.ctrl && !asBoolean(event.ctrlKey)) {
      return false;
    }

    if (hotkey.shift && !asBoolean(event.shiftKey)) {
      return false;
    }

    if (hotkey.meta && !asBoolean(event.metaKey)) {
      return false;
    }

    return true;
  }

  private safeEmitPhase(phase: GlobalPttPhase): void {
    try {
      this.onPhase?.(phase);
    } catch (error) {
      console.warn("[global-ptt] phase listener failed:", error);
    }
  }
}
