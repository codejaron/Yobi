import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizeModifier(key: string): string | null {
  const lower = key.trim().toLowerCase();
  if (lower === "command" || lower === "cmd") {
    return "command down";
  }

  if (lower === "shift") {
    return "shift down";
  }

  if (lower === "option" || lower === "alt") {
    return "option down";
  }

  if (lower === "control" || lower === "ctrl") {
    return "control down";
  }

  return null;
}

function normalizeKeyName(key: string): string {
  const lower = key.trim().toLowerCase();

  if (lower === "enter" || lower === "return") {
    return "return";
  }

  if (lower === "tab") {
    return "tab";
  }

  if (lower === "space") {
    return "space";
  }

  if (lower === "escape" || lower === "esc") {
    return "escape";
  }

  return lower;
}

export class MacOSAdapter {
  async openApp(appName: string): Promise<void> {
    const name = escapeAppleScriptString(appName);
    await this.runAppleScript(`tell application "${name}" to activate`);
  }

  async getAppWindows(appName: string): Promise<Array<{ title: string }>> {
    const name = escapeAppleScriptString(appName);
    const script = [
      'set AppleScript\'s text item delimiters to "\\n"',
      `tell application "System Events" to tell process "${name}" to get name of windows`,
      "set theItems to result",
      "if class of theItems is text then return theItems",
      "return theItems as text"
    ].join("\n");

    const output = await this.runAppleScript(script);
    return output
      .split(/\n+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((title) => ({ title }));
  }

  async typeText(text: string): Promise<void> {
    const escaped = escapeAppleScriptString(text);
    await this.runAppleScript(`tell application "System Events" to keystroke "${escaped}"`);
  }

  async pressKeys(keys: string[]): Promise<void> {
    const cleaned = keys.map((key) => key.trim()).filter(Boolean);
    if (cleaned.length === 0) {
      throw new Error("press_keys 需要至少一个按键");
    }

    const primary = normalizeKeyName(cleaned.at(-1) ?? "");
    const modifiers = cleaned
      .slice(0, -1)
      .map((key) => normalizeModifier(key))
      .filter((item): item is string => Boolean(item));

    const using = modifiers.length > 0 ? ` using {${modifiers.join(", ")}}` : "";

    if (primary === "return") {
      await this.runAppleScript(`tell application "System Events" to key code 36${using}`);
      return;
    }

    if (primary === "tab") {
      await this.runAppleScript(`tell application "System Events" to key code 48${using}`);
      return;
    }

    if (primary === "space") {
      await this.runAppleScript(`tell application "System Events" to key code 49${using}`);
      return;
    }

    if (primary === "escape") {
      await this.runAppleScript(`tell application "System Events" to key code 53${using}`);
      return;
    }

    if (primary.length !== 1 && !primary.startsWith("f")) {
      throw new Error(`暂不支持的按键: ${primary}`);
    }

    const escapedPrimary = escapeAppleScriptString(primary);
    const command = `tell application "System Events" to keystroke "${escapedPrimary}"${using}`;
    await this.runAppleScript(command);
  }

  async notify(title: string, body: string): Promise<void> {
    const escapedTitle = escapeAppleScriptString(title);
    const escapedBody = escapeAppleScriptString(body);
    await this.runAppleScript(`display notification "${escapedBody}" with title "${escapedTitle}"`);
  }

  private async runAppleScript(script: string): Promise<string> {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      timeout: 10_000,
      maxBuffer: 512_000
    });

    return stdout.trim();
  }
}
