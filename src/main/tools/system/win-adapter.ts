import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function escapePowerShellString(value: string): string {
  return value.replace(/'/g, "''");
}

function escapeSendKeysText(value: string): string {
  return value.replace(/[{}+^%~()]/g, (char) => {
    switch (char) {
      case "{":
        return "{{}";
      case "}":
        return "{}}";
      default:
        return `{${char}}`;
    }
  });
}

function normalizeModifier(key: string): string {
  const lower = key.trim().toLowerCase();
  if (lower === "control" || lower === "ctrl") {
    return "^";
  }

  if (lower === "shift") {
    return "+";
  }

  if (lower === "alt" || lower === "option") {
    return "%";
  }

  if (["meta", "cmd", "command", "super", "win", "windows"].includes(lower)) {
    throw new Error(`暂不支持的修饰键: ${key}`);
  }

  throw new Error(`暂不支持的修饰键: ${key}`);
}

function normalizePrimaryKey(key: string): string {
  const lower = key.trim().toLowerCase();
  if (lower === "enter" || lower === "return") {
    return "{ENTER}";
  }

  if (lower === "tab") {
    return "{TAB}";
  }

  if (lower === "space") {
    return " ";
  }

  if (lower === "escape" || lower === "esc") {
    return "{ESC}";
  }

  if (lower === "backspace") {
    return "{BACKSPACE}";
  }

  if (lower === "delete" || lower === "del") {
    return "{DELETE}";
  }

  if (lower === "up") {
    return "{UP}";
  }

  if (lower === "down") {
    return "{DOWN}";
  }

  if (lower === "left") {
    return "{LEFT}";
  }

  if (lower === "right") {
    return "{RIGHT}";
  }

  if (lower === "home") {
    return "{HOME}";
  }

  if (lower === "end") {
    return "{END}";
  }

  if (lower === "pageup" || lower === "page_up") {
    return "{PGUP}";
  }

  if (lower === "pagedown" || lower === "page_down") {
    return "{PGDN}";
  }

  if (lower === "insert") {
    return "{INSERT}";
  }

  if (/^f\d{1,2}$/i.test(lower)) {
    return `{${lower.toUpperCase()}}`;
  }

  if (key.length === 1) {
    return escapeSendKeysText(key);
  }

  throw new Error(`暂不支持的按键: ${key}`);
}

export class WindowsAdapter {
  async openApp(appName: string): Promise<void> {
    await this.runPowerShell(`Start-Process -FilePath '${escapePowerShellString(appName)}'`);
  }

  async getAppWindows(appName?: string): Promise<Array<{ title: string }>> {
    const target = (appName ?? "").trim();
    const script =
      target.length === 0
        ? "$ErrorActionPreference = 'Stop'; Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -ExpandProperty MainWindowTitle"
        : [
            "$ErrorActionPreference = 'Stop'",
            `$pattern = [regex]::Escape('${escapePowerShellString(target)}')`,
            "Get-Process | Where-Object { $_.MainWindowTitle -and ($_.ProcessName -match $pattern -or $_.MainWindowTitle -match $pattern) } | Select-Object -ExpandProperty MainWindowTitle"
          ].join("; ");

    const output = await this.runPowerShell(script);
    return output
      .split(/\r?\n+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((title) => ({ title }));
  }

  async typeText(text: string): Promise<void> {
    const escaped = escapePowerShellString(escapeSendKeysText(text));
    await this.runPowerShell(
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`
    );
  }

  async pressKeys(keys: string[]): Promise<void> {
    const cleaned = keys.map((key) => key.trim()).filter(Boolean);
    if (cleaned.length === 0) {
      throw new Error("press_keys 需要至少一个按键");
    }

    const modifiers = cleaned.slice(0, -1).map((key) => normalizeModifier(key)).join("");
    const primary = normalizePrimaryKey(cleaned.at(-1) ?? "");
    const sequence = escapePowerShellString(`${modifiers}${primary}`);
    await this.runPowerShell(
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sequence}')`
    );
  }

  async notify(title: string, body: string): Promise<void> {
    const script = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
      '$template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02',
      '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)',
      '$texts = $xml.GetElementsByTagName("text")',
      `$texts.Item(0).AppendChild($xml.CreateTextNode('${escapePowerShellString(title)}')) > $null`,
      `$texts.Item(1).AppendChild($xml.CreateTextNode('${escapePowerShellString(body)}')) > $null`,
      "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Yobi").Show($toast)'
    ].join(";");

    await this.runPowerShell(script);
  }

  protected async runPowerShell(script: string): Promise<string> {
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", script], {
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 512_000
    });

    return stdout.trim();
  }
}
