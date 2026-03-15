import test from "node:test";
import assert from "node:assert/strict";
import { WindowsAdapter } from "@main/tools/system/win-adapter";

class TestWindowsAdapter extends WindowsAdapter {
  scripts: string[] = [];
  outputs: string[] = [];

  protected override async runPowerShell(script: string): Promise<string> {
    this.scripts.push(script);
    return this.outputs.shift() ?? "";
  }
}

test("WindowsAdapter.getAppWindows: parses newline-separated window titles and escapes app name", async () => {
  const adapter = new TestWindowsAdapter();
  adapter.outputs.push("Inbox\nDraft - O'Hara\n");

  const result = await adapter.getAppWindows("O'Hara");

  assert.deepEqual(result, [
    { title: "Inbox" },
    { title: "Draft - O'Hara" }
  ]);
  assert.match(adapter.scripts[0] ?? "", /\[regex\]::Escape\('O''Hara'\)/);
  assert.match(adapter.scripts[0] ?? "", /MainWindowTitle/);
});

test("WindowsAdapter.typeText: escapes SendKeys metacharacters", async () => {
  const adapter = new TestWindowsAdapter();

  await adapter.typeText("a+b^c%d~e(f)g{h}i'j");

  assert.equal(
    adapter.scripts[0],
    "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('a{+}b{^}c{%}d{~}e{(}f{)}g{{}h{}}i''j')"
  );
});

test("WindowsAdapter.pressKeys: maps common modifiers and special keys to SendKeys syntax", async () => {
  const adapter = new TestWindowsAdapter();

  await adapter.pressKeys(["ctrl", "shift", "enter"]);

  assert.equal(
    adapter.scripts[0],
    "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^+{ENTER}')"
  );
});

test("WindowsAdapter.pressKeys: rejects unsupported Windows key chords", async () => {
  const adapter = new TestWindowsAdapter();

  await assert.rejects(() => adapter.pressKeys(["win", "r"]), /暂不支持的修饰键/);
});
