import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class WindowsAdapter {
  async openApp(appName: string): Promise<void> {
    await this.runPowerShell(`Start-Process -FilePath \"${appName}\"`);
  }

  async getAppWindows(): Promise<Array<{ title: string }>> {
    throw new Error("Windows get_windows 适配暂未完成。");
  }

  async typeText(): Promise<void> {
    throw new Error("Windows type_text 适配暂未完成。");
  }

  async pressKeys(): Promise<void> {
    throw new Error("Windows press_keys 适配暂未完成。");
  }

  async notify(title: string, body: string): Promise<void> {
    const script = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
      '$template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02',
      '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)',
      '$texts = $xml.GetElementsByTagName("text")',
      `$texts.Item(0).AppendChild($xml.CreateTextNode("${title}")) > $null`,
      `$texts.Item(1).AppendChild($xml.CreateTextNode("${body}")) > $null`,
      "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Yobi").Show($toast)'
    ].join(";");

    await this.runPowerShell(script);
  }

  private async runPowerShell(script: string): Promise<void> {
    await execFileAsync("powershell", ["-NoProfile", "-Command", script], {
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 512_000
    });
  }
}
