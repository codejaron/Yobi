const MODIFIER_KEY_NAMES = new Set(["alt", "control", "ctrl", "shift", "meta", "os"]);

export const DEFAULT_PTT_HOTKEY = "Alt+Space";

function normalizeModifierToken(token: string): "Ctrl" | "Alt" | "Shift" | "Meta" | null {
  const lower = token.trim().toLowerCase();
  if (!lower) {
    return null;
  }

  if (["ctrl", "control", "ctl"].includes(lower)) {
    return "Ctrl";
  }

  if (["alt", "option", "opt"].includes(lower)) {
    return "Alt";
  }

  if (lower === "shift") {
    return "Shift";
  }

  if (["meta", "cmd", "command", "super", "win", "windows"].includes(lower)) {
    return "Meta";
  }

  return null;
}

function normalizePrimaryKeyToken(token: string): string {
  const normalized = token.trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  if (normalized === "space" || normalized === "spacebar" || normalized === "空格") {
    return "Space";
  }

  if (normalized === "enter" || normalized === "return" || normalized === "回车") {
    return "Enter";
  }

  if (normalized === "tab") {
    return "Tab";
  }

  if (normalized === "esc" || normalized === "escape") {
    return "Esc";
  }

  if (normalized === "backspace") {
    return "Backspace";
  }

  if (/^[a-z]$/.test(normalized)) {
    return normalized.toUpperCase();
  }

  if (/^[0-9]$/.test(normalized)) {
    return normalized;
  }

  if (/^f([1-9]|1[0-2])$/.test(normalized)) {
    return normalized.toUpperCase();
  }

  return token.trim().toUpperCase();
}

export function normalizeHotkeyString(raw: string): string {
  const tokens = raw
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return "";
  }

  const modifiers = {
    Ctrl: false,
    Alt: false,
    Shift: false,
    Meta: false
  };
  let keyToken = "";

  for (const token of tokens) {
    const modifier = normalizeModifierToken(token);
    if (modifier) {
      modifiers[modifier] = true;
      continue;
    }

    if (!keyToken) {
      keyToken = normalizePrimaryKeyToken(token);
    }
  }

  if (!keyToken) {
    return "";
  }

  const normalizedParts: string[] = [];
  if (modifiers.Ctrl) {
    normalizedParts.push("Ctrl");
  }
  if (modifiers.Alt) {
    normalizedParts.push("Alt");
  }
  if (modifiers.Shift) {
    normalizedParts.push("Shift");
  }
  if (modifiers.Meta) {
    normalizedParts.push("Meta");
  }
  normalizedParts.push(keyToken);
  return normalizedParts.join("+");
}

function keyFromKeyboardEvent(event: KeyboardEvent): string {
  const code = event.code;

  if (code === "Space") {
    return "Space";
  }
  if (code === "Enter" || code === "NumpadEnter") {
    return "Enter";
  }
  if (code === "Tab") {
    return "Tab";
  }
  if (code === "Escape") {
    return "Esc";
  }
  if (code === "Backspace") {
    return "Backspace";
  }

  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3);
  }

  if (/^Digit[0-9]$/.test(code)) {
    return code.slice(5);
  }

  if (/^F([1-9]|1[0-2])$/.test(code)) {
    return code;
  }

  const normalized = event.key.trim();
  if (!normalized) {
    return "";
  }

  if (normalized.length === 1 && /[a-z0-9]/i.test(normalized)) {
    return normalized.toUpperCase();
  }

  if (["Space", "Enter", "Tab", "Esc", "Backspace"].includes(normalized)) {
    return normalized;
  }

  return "";
}

export function hotkeyFromKeyboardEvent(
  event: KeyboardEvent
): {
  hotkey: string | null;
  error: string | null;
} {
  const keyToken = keyFromKeyboardEvent(event);
  if (!keyToken) {
    return {
      hotkey: null,
      error: null
    };
  }

  if (MODIFIER_KEY_NAMES.has(keyToken.toLowerCase())) {
    return {
      hotkey: null,
      error: null
    };
  }

  const modifiers: string[] = [];
  if (event.ctrlKey) {
    modifiers.push("Ctrl");
  }
  if (event.altKey) {
    modifiers.push("Alt");
  }
  if (event.shiftKey) {
    modifiers.push("Shift");
  }
  if (event.metaKey) {
    modifiers.push("Meta");
  }

  if (modifiers.length === 0) {
    return {
      hotkey: null,
      error: "快捷键至少需要一个修饰键（Ctrl/Option/Shift/Command）。"
    };
  }

  return {
    hotkey: normalizeHotkeyString([...modifiers, keyToken].join("+")),
    error: null
  };
}

export function formatHotkeyText(raw: string, isMac: boolean): string {
  const normalized = normalizeHotkeyString(raw) || DEFAULT_PTT_HOTKEY;
  const parts = normalized.split("+");
  const mapped = parts.map((part) => {
    if (part === "Ctrl") {
      return isMac ? "Control" : "Ctrl";
    }
    if (part === "Alt") {
      return isMac ? "Option" : "Alt";
    }
    if (part === "Shift") {
      return "Shift";
    }
    if (part === "Meta") {
      return isMac ? "Command" : "Meta";
    }
    if (part === "Esc") {
      return "Esc";
    }
    if (part === "Space") {
      return "Space";
    }
    return part;
  });

  return mapped.join("+");
}

export function formatHotkeySymbol(raw: string, isMac: boolean): string {
  const normalized = normalizeHotkeyString(raw) || DEFAULT_PTT_HOTKEY;
  const parts = normalized.split("+");
  if (!isMac) {
    return parts.join("+");
  }

  const mapped = parts.map((part) => {
    if (part === "Ctrl") {
      return "⌃";
    }
    if (part === "Alt") {
      return "⌥";
    }
    if (part === "Shift") {
      return "⇧";
    }
    if (part === "Meta") {
      return "⌘";
    }
    if (part === "Space") {
      return "Space";
    }
    return part;
  });

  return mapped.join(" ");
}
